import "server-only";
import type { BrowserContext, Page } from "playwright";
import { openSessionContext } from "../fetcher/browser";
import { parseCookies } from "../fetcher/browser";
import { FetchError } from "../fetcher/errors";
import { preflight } from "../fetcher";
import { detectBotWall, penalize, reward, withHostTurn } from "../fetcher/politeness";
import { recordHostRequest, ruleForHost } from "../repo/sites";
import { getSettings } from "../repo/settings";
import { buildPageContext, linkLines } from "./context";

/**
 * The agent's own browser: open a page, see its links, buttons and fields as a numbered list, click,
 * type, choose, scroll and go back. Every navigation passes the same checks as any Scaper request
 * (public address, robots.txt, the site's pause and backoff, the polite delay), bot checks stop the
 * session, and the model only ever picks an element number and text; it never runs code in the page.
 */

const MAX_ACTIONS = 40;
const IDLE_MS = 10 * 60_000;
const MAX_ELEMENTS = 90;

type Ref = { n: number; kind: string; label: string; href?: string; value?: string; password?: boolean };

// Collects visible interactive elements and tags each with data-scaper-ref so the next action can find it.
// This is Scaper's own fixed script, not anything the model wrote.
const OBSERVE = (max: number) => {
  const seen = new Set<Element>();
  const out: { n: number; kind: string; label: string; href?: string; value?: string; password?: boolean }[] = [];
  document.querySelectorAll("[data-scaper-ref]").forEach((el) => el.removeAttribute("data-scaper-ref"));
  const els = document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], summary");
  for (const el of Array.from(els)) {
    if (out.length >= max || seen.has(el)) continue;
    seen.add(el);
    const r = (el as HTMLElement).getBoundingClientRect();
    const st = getComputedStyle(el as HTMLElement);
    if (r.width < 2 || r.height < 2 || st.visibility === "hidden" || st.display === "none") continue;
    const tag = el.tagName.toLowerCase();
    const input = el as HTMLInputElement;
    const kind = tag === "a" ? "link" : tag === "input" ? `input:${input.type || "text"}` : tag === "select" ? "select" : tag === "textarea" ? "textarea" : "button";
    const label = ((el as HTMLElement).innerText || input.placeholder || el.getAttribute("aria-label") || el.getAttribute("title") || input.name || input.value || "")
      .replace(/\s+/g, " ").trim().slice(0, 80);
    if (!label && kind === "link") continue;
    const n = out.length + 1;
    el.setAttribute("data-scaper-ref", String(n));
    out.push({
      n, kind, label,
      href: tag === "a" ? (el as HTMLAnchorElement).href.slice(0, 300) : undefined,
      value: tag === "select" ? Array.from((el as HTMLSelectElement).options).map((o) => o.text.trim()).slice(0, 15).join(" | ") : tag === "input" && input.type !== "password" ? input.value.slice(0, 60) : undefined,
      password: input.type === "password" || undefined,
    });
  }
  return out;
};

export class AgentBrowser {
  private ctx: { context: BrowserContext; close: () => Promise<void> } | null = null;
  private page: Page | null = null;
  private actions = 0;
  private idle: NodeJS.Timeout | null = null;
  private elements: Ref[] = [];
  private cookiedHosts = new Set<string>();

  constructor(private signal?: AbortSignal) {}

  private async ensure() {
    if (this.page && !this.page.isClosed()) return this.page;
    const s = getSettings().scraping;
    this.ctx = await openSessionContext({
      userAgent: s.userAgent, proxyUrl: s.proxyUrl, allowPrivate: s.allowPrivateNetwork, blockHeavy: s.blockHeavyResources, maxConcurrency: s.maxConcurrency,
      headersFor: (host) => { const r = ruleForHost(host); return r?.headers.length ? Object.fromEntries(r.headers.map((h) => [h.name, h.value])) : null; },
    });
    this.page = await this.ctx.context.newPage();
    this.page.setDefaultTimeout(s.timeoutSeconds * 1000);
    return this.page;
  }

  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.close(), IDLE_MS);
    this.idle.unref?.();
  }

  private count() {
    if (++this.actions > MAX_ACTIONS) throw new FetchError("step", `The agent's browser is limited to ${MAX_ACTIONS} actions per request.`);
    if (this.signal?.aborted) throw new FetchError("cancelled", "Cancelled.");
    this.touch();
  }

  private async addSiteCookies(url: string) {
    const host = new URL(url).hostname;
    if (this.cookiedHosts.has(host) || !this.ctx) return;
    this.cookiedHosts.add(host);
    const cookies = ruleForHost(host)?.cookies;
    if (cookies) await this.ctx.context.addCookies(parseCookies(cookies, new URL(url).origin)).catch(() => undefined);
  }

  /** Runs one step that may load a page, inside the host's polite turn, then checks where it ended up. */
  private async navigateStep(targetUrl: string, step: (page: Page) => Promise<unknown>) {
    const pre = await preflight(targetUrl, { signal: this.signal });
    const page = await this.ensure();
    await this.addSiteCookies(targetUrl);
    const started = Date.now();
    await withHostTurn(pre.host, pre.minDelayMs, async () => {
      await step(page);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
    });
    await this.afterLoad(Date.now() - started);
  }

  private async afterLoad(ms: number) {
    const page = this.page!;
    const url = page.url();
    if (!/^https?:/i.test(url)) return;
    const host = new URL(url).hostname;
    // A click can land anywhere: the landing page must pass the same checks, or the session steps back.
    try {
      await preflight(url, { signal: this.signal });
    } catch (e) {
      await page.goBack().catch(() => undefined);
      throw e;
    }
    const html = await page.content();
    const wall = detectBotWall(html, 200);
    if (wall) {
      penalize(host);
      recordHostRequest(host, { ok: false, blocked: true, ms, bytes: 0, status: null });
      throw new FetchError("blocked", `${wall}. Scaper does not get around bot checks, so the agent stopped browsing ${host}.`);
    }
    reward(host);
    recordHostRequest(host, { ok: true, blocked: false, ms, bytes: html.length, status: 200 });
  }

  async open(url: string) {
    this.count();
    await this.navigateStep(url, (page) => page.goto(url, { waitUntil: "domcontentloaded" }));
    return this.observe();
  }

  /** The numbered list of what can be clicked or filled, plus the start of the page text. */
  async observe() {
    const page = await this.ensure();
    if (page.url() === "about:blank") return "No page is open yet. Use browser_open first.";
    this.elements = await page.evaluate(OBSERVE, MAX_ELEMENTS);
    const text = (await page.evaluate(() => document.body?.innerText ?? "")).replace(/\n{2,}/g, "\n").slice(0, 2500);
    const list = this.elements.map((e) => `[${e.n}] ${e.kind}${e.password ? " (password)" : ""}: ${e.label || "(no label)"}${e.value ? ` = ${e.value}` : ""}${e.href ? ` → ${e.href}` : ""}`).join("\n");
    return `URL: ${page.url()}\nTitle: ${await page.title()}\nElements (use the number with browser_act):\n${list || "(none visible)"}\n<page>\n${text}\n</page>`;
  }

  async act(action: string, n?: number, text?: string) {
    this.count();
    const page = await this.ensure();
    if (page.url() === "about:blank") throw new FetchError("step", "No page is open yet. Use browser_open first.");
    const el = n ? this.elements.find((e) => e.n === n) : undefined;
    if (["click", "type", "select"].includes(action) && !el) throw new FetchError("step", `There is no element [${n}] on this page. Call browser_observe to see the current list.`);
    const loc = n ? page.locator(`[data-scaper-ref="${n}"]`).first() : null;
    const current = page.url();
    switch (action) {
      case "click":
        await this.navigateStep(el!.href && /^https?:/i.test(el!.href) ? el!.href : current, () => loc!.click({ timeout: 8000 }));
        break;
      case "type": {
        if (el!.password) throw new FetchError("step", "Scaper does not type passwords. To use your account on a site, add its cookies on the Sites page.");
        const value = String(text ?? "").slice(0, 500);
        await loc!.fill(value, { timeout: 8000 });
        break;
      }
      case "submit": {
        const value = String(text ?? "").slice(0, 500);
        if (el?.password) throw new FetchError("step", "Scaper does not type passwords. To use your account on a site, add its cookies on the Sites page.");
        await this.navigateStep(current, async () => {
          if (loc && value) await loc.fill(value, { timeout: 8000 });
          await (loc ?? page.locator(":focus")).press("Enter");
        });
        break;
      }
      case "select":
        await this.navigateStep(current, () => loc!.selectOption({ label: String(text ?? "") }, { timeout: 8000 }).catch(() => loc!.selectOption(String(text ?? ""), { timeout: 8000 })));
        break;
      case "scroll":
        await page.mouse.wheel(0, text === "up" ? -1800 : 1800);
        await page.waitForTimeout(600);
        break;
      case "back":
        await this.navigateStep(current, () => page.goBack());
        break;
      default:
        throw new FetchError("step", `Unknown action "${action}". Use click, type, submit, select, scroll or back.`);
    }
    return this.observe();
  }

  /** The current page as Markdown with numbered links, for reading content after clicking around. */
  async read(budgetTokens = 5000) {
    const page = await this.ensure();
    if (page.url() === "about:blank") return "No page is open yet. Use browser_open first.";
    const ctx = buildPageContext(await page.content(), page.url(), { scope: "main", budgetTokens });
    return `URL: ${ctx.url}\nTitle: ${ctx.title}\n<page>\n${ctx.markdown}\n\nLinks:\n${linkLines(ctx.links, ctx.url, 60)}\n</page>`;
  }

  async html() {
    const page = await this.ensure();
    return { html: await page.content(), url: page.url() };
  }

  async close() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const c = this.ctx;
    this.ctx = null;
    this.page = null;
    await c?.close();
  }
}
