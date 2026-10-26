import "server-only";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Dialog, type Page } from "playwright";
import { env } from "../env";
import { executablePath } from "../fetcher/browser";
import { FetchError } from "../fetcher/errors";
import { assertPublicUrl } from "../fetcher/network-guard";
import { preflight } from "../fetcher";
import { log } from "../log";
import { isPrivate } from "../privacy";
import { addHistory, annotationsFor, saveAnnotation, setHistoryTitle, type Annotation, type AnnotationElement } from "../repo/browser";
import { audit } from "../repo/events";
import { getSettings } from "../repo/settings";
import { buildPageContext, linkLines } from "../ai/context";
import { OBSERVE, type Ref } from "../ai/browser-session";
import { enabledExtensionDirs } from "./extensions";

/**
 * Scaper's visual browser: one Chromium you drive from the Browser page. The page is streamed to you as a live
 * picture (Chrome's own screencast, so only changed frames are sent) and your clicks, keys and scrolls are sent
 * back. The normal profile keeps cookies, logins, extensions and history in data/browser-profile; incognito is a
 * fresh profile in memory that keeps nothing. Your AI and bots can read the open page and your annotations, and
 * act in it when you allow it. Pages the AI opens pass Scaper's usual checks (robots.txt, site rules, network guard).
 */

export type Mode = "normal" | "incognito";
type Tab = { id: string; page: Page; title: string; url: string; loading: boolean };
type Frame = { data: string; width: number; height: number; scrollX: number; scrollY: number; tabId: string };
export type LiveEvent =
  | { type: "frame"; frame: Frame }
  | { type: "state"; state: LiveState }
  | { type: "dialog"; kind: string; message: string; defaultValue: string }
  | { type: "notice"; level: "info" | "warning"; message: string };
export type LiveState = {
  open: boolean; mode: Mode | null; activeId: string | null; viewport: { width: number; height: number };
  tabs: { id: string; title: string; url: string; loading: boolean }[];
  extensions: number; startedAt: string | null; aiActing: boolean;
};

type S = {
  mode: Mode | null; browser: Browser | null; context: BrowserContext | null; tabs: Map<string, Tab>; order: string[]; activeId: string | null;
  cdp: CDPSession | null; streamingId: string | null; viewport: { width: number; height: number }; lastFrame: Frame | null;
  subscribers: Set<(e: LiveEvent) => void>; opening: Promise<void> | null; idle: NodeJS.Timeout | null; startedAt: string | null;
  dialog: Dialog | null; elements: Ref[]; seq: number; extensions: number; aiActing: boolean; incognitoNotes: Annotation[];
};
const g = globalThis as unknown as { __scaperLive?: S };
const s: S = (g.__scaperLive ??= {
  mode: null, browser: null, context: null, tabs: new Map(), order: [], activeId: null, cdp: null, streamingId: null,
  viewport: { width: 1280, height: 800 }, lastFrame: null, subscribers: new Set(), opening: null, idle: null, startedAt: null,
  dialog: null, elements: [], seq: 0, extensions: 0, aiActing: false, incognitoNotes: [],
});

/** With nobody watching for this long, the browser closes to free memory. The normal profile keeps everything. */
const IDLE_MS = 20 * 60_000;
export const profileDir = () => path.join(env.dataDir, "browser-profile");

function emit(e: LiveEvent) {
  for (const fn of s.subscribers) { try { fn(e); } catch { /* a closed stream */ } }
}

export function liveState(): LiveState {
  return {
    open: Boolean(s.context), mode: s.mode, activeId: s.activeId, viewport: s.viewport, extensions: s.extensions, startedAt: s.startedAt, aiActing: s.aiActing,
    tabs: s.order.map((id) => s.tabs.get(id)!).filter(Boolean).map((t) => ({ id: t.id, title: t.title, url: t.url, loading: t.loading })),
  };
}
let stateTimer: NodeJS.Timeout | null = null;
/** State changes come in bursts (a page load fires several); send one update. */
function pushState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => { stateTimer = null; emit({ type: "state", state: liveState() }); }, 60);
}

/** Watching the stream. Returns an unsubscribe; the latest picture is sent at once. */
export function subscribe(fn: (e: LiveEvent) => void) {
  s.subscribers.add(fn);
  if (s.idle) { clearTimeout(s.idle); s.idle = null; }
  fn({ type: "state", state: liveState() });
  if (s.lastFrame) fn({ type: "frame", frame: s.lastFrame });
  return () => {
    s.subscribers.delete(fn);
    if (!s.subscribers.size && s.context) {
      s.idle = setTimeout(() => void closeLive("idle"), IDLE_MS);
      s.idle.unref?.();
    }
  };
}

const launchOptions = (args: string[]) => {
  const exe = executablePath();
  const proxyUrl = getSettings().scraping.proxyUrl;
  const proxy = proxyUrl ? (() => { const u = new URL(proxyUrl); return { server: `${u.protocol}//${u.host}`, username: u.username ? decodeURIComponent(u.username) : undefined, password: u.password ? decodeURIComponent(u.password) : undefined }; })() : undefined;
  // Extensions need the full Chromium, not the small headless shell Playwright uses by default.
  return { headless: true, ...(exe ? { executablePath: exe } : { channel: "chromium" }), proxy, args };
};

/** Opens the browser in a mode (switching mode closes the other one). */
export async function openLive(mode: Mode = "normal") {
  if (isPrivate() || getSettings().data.privateMode) mode = "incognito";
  if (s.context && s.mode === mode) return liveState();
  if (s.opening) await s.opening;
  if (s.context && s.mode !== mode) await closeLive("switch");
  if (s.context) return liveState();
  s.opening = (async () => {
    const vp = s.viewport;
    if (mode === "normal") {
      const dirs = enabledExtensionDirs();
      const ext = dirs.length ? [`--disable-extensions-except=${dirs.join(",")}`, `--load-extension=${dirs.join(",")}`] : [];
      fs.mkdirSync(profileDir(), { recursive: true });
      s.context = await chromium.launchPersistentContext(profileDir(), { ...launchOptions(ext), viewport: vp, acceptDownloads: true, locale: "en-IN" });
      s.browser = null;
      s.extensions = dirs.length;
    } else {
      s.browser = await chromium.launch(launchOptions([]));
      s.context = await s.browser.newContext({ viewport: vp, acceptDownloads: true, locale: "en-IN" });
      s.extensions = 0;
    }
    s.mode = mode;
    s.startedAt = new Date().toISOString();
    s.context.on("page", (p) => void adopt(p));
    s.context.on("close", () => { if (s.mode) void closeLive("crash"); });
    const pages = s.context.pages();
    for (const p of pages) await adopt(p, false);
    if (!s.order.length) await adopt(await s.context.newPage(), false);
    const first = s.order[0]!;
    await activate(first);
    const home = getSettings().data.browserHome;
    if (s.tabs.get(first)!.url === "about:blank" && home) void navigate(home, first).catch(() => undefined);
    audit("browser.opened", { mode, extensions: s.extensions });
    log.info("live_browser.opened", { mode, extensions: s.extensions });
  })();
  try { await s.opening; } catch (e) {
    await closeLive("failed");
    const msg = (e as Error).message;
    throw new FetchError("browser", /Executable doesn't exist|channel/i.test(msg)
      ? "The browser is not installed yet. Install it in Settings → Scraping → Scraping browser (one click), then open the Browser again."
      : `The browser could not start: ${msg.split("\n")[0]}`);
  } finally { s.opening = null; }
  pushState();
  return liveState();
}

export async function closeLive(reason = "you") {
  const ctx = s.context, browser = s.browser;
  s.context = null; s.browser = null; s.mode = null; s.tabs.clear(); s.order = []; s.activeId = null;
  s.cdp = null; s.streamingId = null; s.lastFrame = null; s.dialog = null; s.startedAt = null; s.incognitoNotes = [];
  if (s.idle) { clearTimeout(s.idle); s.idle = null; }
  await ctx?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  if (ctx) log.info("live_browser.closed", { reason });
  pushState();
}

async function adopt(page: Page, focus = true) {
  const id = `t${++s.seq}`;
  const tab: Tab = { id, page, title: "", url: page.url(), loading: false };
  s.tabs.set(id, tab);
  s.order.push(id);
  page.on("framenavigated", (f) => {
    if (f !== page.mainFrame()) return;
    tab.url = page.url();
    if (s.mode === "normal" && getSettings().data.browserHistory && !getSettings().data.privateMode && /^https?:/i.test(tab.url)) addHistory(tab.url, tab.title);
    pushState();
  });
  page.on("load", () => {
    tab.loading = false;
    void page.title().then((t) => { tab.title = t; if (s.mode === "normal" && /^https?:/i.test(tab.url)) setHistoryTitle(tab.url, t); pushState(); }).catch(() => undefined);
  });
  page.on("domcontentloaded", () => { void page.title().then((t) => { tab.title = t; pushState(); }).catch(() => undefined); });
  page.on("request", (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) { tab.loading = true; pushState(); } });
  page.on("close", () => {
    s.tabs.delete(id);
    s.order = s.order.filter((x) => x !== id);
    if (s.activeId === id) { s.activeId = null; const next = s.order.at(-1); if (next) void activate(next); }
    pushState();
  });
  page.on("dialog", (d) => {
    s.dialog = d;
    emit({ type: "dialog", kind: d.type(), message: d.message().slice(0, 2000), defaultValue: d.defaultValue() });
    // Nobody answers within a minute: dismiss it so the page does not hang.
    setTimeout(() => { if (s.dialog === d) { s.dialog = null; void d.dismiss().catch(() => undefined); } }, 60_000).unref?.();
  });
  page.on("download", (d) => void (async () => {
    const url = d.url();
    await d.cancel().catch(() => undefined);
    if (!/^https?:/i.test(url)) { emit({ type: "notice", level: "warning", message: "That download was made by the page itself, so it cannot go to the download manager." }); return; }
    const { queueDownloads } = await import("../downloads/manager");
    const r = queueDownloads([url], { folder: "Browser", source: "manual" });
    emit({ type: "notice", level: "info", message: r.added.length ? "Sent to Downloads (folder Browser)." : "That file is already in Downloads." });
  })());
  await page.setViewportSize(s.viewport).catch(() => undefined);
  if (focus) await activate(id);
  pushState();
  return id;
}

/** Streams the active tab only: Chrome sends a frame when something changes on screen. */
async function activate(id: string) {
  const tab = s.tabs.get(id);
  if (!tab || !s.context) return;
  s.activeId = id;
  if (s.streamingId === id && s.cdp) { pushState(); return; }
  const old = s.cdp;
  s.cdp = null;
  if (old) { await old.send("Page.stopScreencast").catch(() => undefined); await old.detach().catch(() => undefined); }
  const cdp = await s.context.newCDPSession(tab.page);
  s.cdp = cdp;
  s.streamingId = id;
  cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number; scrollOffsetX: number; scrollOffsetY: number } }) => {
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
    if (s.cdp !== cdp) return;
    s.lastFrame = { data: f.data, width: Math.round(f.metadata.deviceWidth), height: Math.round(f.metadata.deviceHeight), scrollX: f.metadata.scrollOffsetX, scrollY: f.metadata.scrollOffsetY, tabId: id };
    emit({ type: "frame", frame: s.lastFrame });
  });
  await startScreencast(cdp);
  await tab.page.bringToFront().catch(() => undefined);
  pushState();
}

async function startScreencast(cdp: CDPSession) {
  const q = getSettings().data.browserQuality;
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: q, maxWidth: s.viewport.width, maxHeight: s.viewport.height, everyNthFrame: 1 }).catch(() => undefined);
}

function activeTab() {
  const t = s.activeId ? s.tabs.get(s.activeId) : null;
  if (!s.context || !t) throw new FetchError("step", "Scaper's browser is not open. Open it on the Browser page first.");
  return t;
}
const tabFor = (id?: string) => (id ? s.tabs.get(id) ?? activeTab() : activeTab());

/** What you typed in the address bar: a link, a host name, or words to search for. */
export function toUrl(input: string) {
  const v = input.trim();
  if (/^(https?|chrome-extension):\/\//i.test(v) || v === "about:blank") return v;
  if (/^chrome:\/\//i.test(v)) throw new FetchError("step", "chrome:// pages are not available in Scaper's browser.");
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/\S*)?$/i.test(v)) return `http://${v}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(v) && !/\s/.test(v)) return `https://${v}`;
  return getSettings().data.browserSearch.replace("%s", encodeURIComponent(v));
}

export async function navigate(input: string, tabId?: string, opts: { byAi?: boolean } = {}) {
  const url = toUrl(input);
  const tab = tabFor(tabId);
  if (/^https?:/i.test(url)) {
    // Your own browsing goes where you say (the network guard still applies); pages the AI opens also pass robots.txt and site rules.
    if (opts.byAi) await preflight(url);
    else await assertPublicUrl(url, getSettings().scraping.allowPrivateNetwork);
  }
  tab.loading = true;
  pushState();
  await tab.page.goto(url, { waitUntil: "domcontentloaded", timeout: getSettings().scraping.timeoutSeconds * 1000 }).catch((e: Error) => {
    if (!/ERR_ABORTED|interrupted by another navigation/i.test(e.message)) emit({ type: "notice", level: "warning", message: `Could not open ${url}: ${e.message.split("\n")[0]!.slice(0, 200)}` });
  });
  tab.loading = false;
  pushState();
  return liveState();
}

export async function action(a: { action: string; url?: string; tabId?: string; width?: number; height?: number; accept?: boolean; text?: string }) {
  switch (a.action) {
    case "navigate": return navigate(a.url ?? "", a.tabId);
    case "back": await tabFor(a.tabId).page.goBack({ timeout: 15_000 }).catch(() => undefined); break;
    case "forward": await tabFor(a.tabId).page.goForward({ timeout: 15_000 }).catch(() => undefined); break;
    case "reload": await tabFor(a.tabId).page.reload({ timeout: 30_000 }).catch(() => undefined); break;
    case "stop": await tabFor(a.tabId).page.evaluate(() => window.stop()).catch(() => undefined); break;
    case "newTab": {
      if (!s.context) throw new FetchError("step", "Scaper's browser is not open.");
      const page = await s.context.newPage();
      const id = [...s.tabs.values()].find((t) => t.page === page)?.id ?? await adopt(page);
      await activate(id);
      if (a.url) await navigate(a.url, id);
      else if (getSettings().data.browserHome) await navigate(getSettings().data.browserHome, id);
      break;
    }
    case "closeTab": {
      const t = s.tabs.get(a.tabId ?? "");
      if (t) {
        if (s.tabs.size === 1) { await navigate("about:blank", t.id); break; }
        await t.page.close().catch(() => undefined);
      }
      break;
    }
    case "switchTab": await activate(a.tabId ?? ""); break;
    case "viewport": await setViewport(a.width ?? 1280, a.height ?? 800); break;
    case "dialog": {
      const d = s.dialog;
      s.dialog = null;
      if (d) await (a.accept ? d.accept(a.text) : d.dismiss()).catch(() => undefined);
      break;
    }
    default: throw new FetchError("step", `Unknown browser action ${a.action}.`);
  }
  pushState();
  return liveState();
}

/** The picture follows the size of the view on your screen, so it stays sharp and nothing is scaled twice. */
export async function setViewport(width: number, height: number) {
  const vp = { width: Math.round(Math.min(Math.max(width, 320), 2560)), height: Math.round(Math.min(Math.max(height, 240), 1600)) };
  if (vp.width === s.viewport.width && vp.height === s.viewport.height) return;
  s.viewport = vp;
  await Promise.all([...s.tabs.values()].map((t) => t.page.setViewportSize(vp).catch(() => undefined)));
  if (s.cdp) { await s.cdp.send("Page.stopScreencast").catch(() => undefined); await startScreencast(s.cdp); }
}

type InputEvent =
  | { type: "mouse"; kind: "move" | "down" | "up" | "click" | "dblclick"; x: number; y: number; button: "left" | "right" | "middle" }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number }
  | { type: "key"; key: string; modifiers: string[] }
  | { type: "text"; text: string };

/** Your mouse and keyboard, in page pixels. */
export async function input(events: InputEvent[]) {
  const { page } = activeTab();
  for (const e of events) {
    if (e.type === "mouse") {
      if (e.kind === "move") await page.mouse.move(e.x, e.y);
      else if (e.kind === "down") { await page.mouse.move(e.x, e.y); await page.mouse.down({ button: e.button }); }
      else if (e.kind === "up") { await page.mouse.move(e.x, e.y); await page.mouse.up({ button: e.button }); }
      else await page.mouse.click(e.x, e.y, { button: e.button, clickCount: e.kind === "dblclick" ? 2 : 1 });
    } else if (e.type === "wheel") {
      await page.mouse.move(e.x, e.y);
      await page.mouse.wheel(e.dx, e.dy);
    } else if (e.type === "key") {
      await page.keyboard.press([...e.modifiers, e.key].join("+")).catch(() => undefined);
    } else {
      await page.keyboard.insertText(e.text);
    }
  }
}

/** A still picture of the active tab (JPEG). */
export async function screenshot(quality = 70) {
  return activeTab().page.screenshot({ type: "jpeg", quality, fullPage: false });
}

// --- Annotations -------------------------------------------------------------------------------------------

/** The element under the middle of a box, so the AI knows what you pointed at. Scaper's own fixed script. */
const ELEMENT_AT = ([x, y]: [number, number]) => {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;
  const pick = el.closest("a, button, li, article, tr, [role], img, h1, h2, h3, p, td") as HTMLElement | null ?? el;
  const sel = (n: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = n;
    while (cur && parts.length < 4 && cur !== document.body) {
      let p = cur.tagName.toLowerCase();
      if (cur.id && /^[a-z][\w-]*$/i.test(cur.id)) { parts.unshift(`${p}#${cur.id}`); break; }
      const cls = Array.from(cur.classList).filter((c) => /^[a-z][\w-]{1,30}$/i.test(c)).slice(0, 2);
      if (cls.length) p += `.${cls.join(".")}`;
      parts.unshift(p);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  };
  return {
    tag: pick.tagName.toLowerCase(), text: (pick.innerText || pick.getAttribute("alt") || pick.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 300),
    selector: sel(pick), href: (pick as HTMLAnchorElement).href || (pick.querySelector("a") as HTMLAnchorElement | null)?.href || undefined,
  };
};

/** A box you drew (in page coordinates, so it stays on the same spot when you scroll) with a note. */
export async function annotate(box: { x: number; y: number; w: number; h: number; note: string; color: string }) {
  const tab = activeTab();
  const scroll = s.lastFrame?.tabId === tab.id ? { x: s.lastFrame.scrollX, y: s.lastFrame.scrollY } : { x: 0, y: 0 };
  const element = await tab.page.evaluate(ELEMENT_AT, [box.x + box.w / 2 - scroll.x, box.y + box.h / 2 - scroll.y] as [number, number]).catch(() => null) as AnnotationElement | null;
  const row = { url: tab.page.url(), title: tab.title, ...box, element };
  // Incognito keeps annotations in memory only.
  if (s.mode === "incognito") {
    const a: Annotation = { ...row, id: `inc-${Date.now()}-${s.incognitoNotes.length}`, created_at: new Date().toISOString() };
    s.incognitoNotes.push(a);
    return a;
  }
  return saveAnnotation(row);
}

export function currentAnnotations(): Annotation[] {
  const t = s.activeId ? s.tabs.get(s.activeId) : null;
  if (!t) return [];
  const url = t.page.url();
  return s.mode === "incognito" ? s.incognitoNotes.filter((a) => a.url === url) : annotationsFor(url);
}
export function removeIncognitoNote(id: string) {
  const n = s.incognitoNotes.length;
  s.incognitoNotes = s.incognitoNotes.filter((a) => a.id !== id);
  return s.incognitoNotes.length < n;
}
export const isIncognito = () => s.mode === "incognito";

export function describeAnnotations(list: Annotation[]) {
  return list.map((a, i) => `${i + 1}. Box at x ${Math.round(a.x)}, y ${Math.round(a.y)} (${Math.round(a.w)}×${Math.round(a.h)} px)${a.note ? ` — the user's note: "${a.note}"` : ""}${a.element ? `\n   Under it: <${a.element.tag}> ${a.element.selector}${a.element.text ? ` "${a.element.text.slice(0, 200)}"` : ""}${a.element.href ? ` → ${a.element.href}` : ""}` : ""}`).join("\n");
}

// --- For the AI ---------------------------------------------------------------------------------------------

/** The open page as Markdown with numbered links, plus your annotations on it. */
export async function readForAi(budgetTokens = 5000) {
  const tab = activeTab();
  const url = tab.page.url();
  if (url === "about:blank") return "Scaper's browser is open but no page is loaded.";
  const ctx = buildPageContext(await tab.page.content(), url, { scope: "main", budgetTokens });
  const notes = currentAnnotations();
  const tabs = s.order.length > 1 ? `\nOther tabs: ${s.order.filter((id) => id !== tab.id).map((id) => s.tabs.get(id)!.title || s.tabs.get(id)!.url).join(" | ").slice(0, 600)}` : "";
  return `URL: ${ctx.url}\nTitle: ${ctx.title}\nScrolled to: ${Math.round(s.lastFrame?.scrollY ?? 0)} px${tabs}\n${notes.length ? `The user's annotations on this page:\n${describeAnnotations(notes)}\n` : "No annotations on this page.\n"}<page>\n${ctx.markdown}\n\nLinks:\n${linkLines(ctx.links, ctx.url, 60)}\n</page>`;
}

export async function observeForAi() {
  const tab = activeTab();
  if (tab.page.url() === "about:blank") return "No page is loaded in Scaper's browser.";
  s.elements = await tab.page.evaluate(OBSERVE, 90);
  return `URL: ${tab.page.url()}\nTitle: ${tab.title}\nElements (use the number with live_browser_act):\n${s.elements.map((e) => `[${e.n}] ${e.kind}${e.password ? " (password)" : ""}: ${e.label || "(no label)"}${e.value ? ` = ${e.value}` : ""}${e.href ? ` → ${e.href}` : ""}`).join("\n") || "(none visible)"}`;
}

/** One step by the AI in your browser, which you watch live. It never types passwords. */
export async function actForAi(act: string, n?: number, text?: string) {
  const tab = activeTab();
  s.aiActing = true;
  pushState();
  try {
    if (act === "open") { await navigate(String(text ?? ""), tab.id, { byAi: true }); return observeForAi(); }
    const el = n ? s.elements.find((e) => e.n === n) : undefined;
    if (["click", "type", "select"].includes(act) && !el) throw new FetchError("step", `There is no element [${n}]. Call live_browser_observe for the current list.`);
    if (el?.password && act !== "click") throw new FetchError("step", "Scaper's AI never types passwords. Type it yourself in the Browser page.");
    const loc = n ? tab.page.locator(`[data-scaper-ref="${n}"]`).first() : null;
    if (act === "click" && el?.href && /^https?:/i.test(el.href)) await preflight(el.href);
    switch (act) {
      case "click": await loc!.click({ timeout: 8000 }); break;
      case "type": await loc!.fill(String(text ?? "").slice(0, 1000), { timeout: 8000 }); break;
      case "submit": if (loc && text) await loc.fill(String(text).slice(0, 1000), { timeout: 8000 }); await (loc ?? tab.page.locator(":focus")).press("Enter"); break;
      case "select": await loc!.selectOption({ label: String(text ?? "") }, { timeout: 8000 }).catch(() => loc!.selectOption(String(text ?? ""), { timeout: 8000 })); break;
      case "scroll": await tab.page.mouse.wheel(0, text === "up" ? -1600 : 1600); break;
      case "back": await tab.page.goBack({ timeout: 15_000 }).catch(() => undefined); break;
      default: throw new FetchError("step", `Unknown action "${act}". Use open, click, type, submit, select, scroll or back.`);
    }
    await tab.page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
    await tab.page.waitForTimeout(400);
    // A click can land anywhere: the AI may not stay on a page Scaper would refuse.
    const now = tab.page.url();
    if (/^https?:/i.test(now)) await preflight(now).catch(async (e: Error) => { await tab.page.goBack().catch(() => undefined); throw e; });
    return observeForAi();
  } finally {
    s.aiActing = false;
    pushState();
  }
}

export const liveOpen = () => Boolean(s.context && s.activeId);
