import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

type Q = { type: string; instructions: string; criteria?: unknown };
type DecisionBody = { model: string; state: unknown; questions: Record<string, Q> };

/**
 * One local server playing three parts: a website (with robots.txt), an OpenAI-compatible chat API and
 * OpenRouter's Decisions API. `decide` scripts the decision answers; `status` forces HTTP errors.
 */
function startWorld() {
  const decisions: { body: DecisionBody; auth?: string }[] = [];
  const chats: string[] = [];
  const ctl = { status: [] as number[], raw: null as string | null };
  const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
  const answer = (name: string, q: Q, state: string): unknown => {
    const s = state.toLowerCase();
    if (q.type === "noul") {
      if (name.startsWith("link_")) return { type: "noul", noul: /laptop|notebook/i.test(q.instructions) ? 0.93 : 0.04 };
      if (name === "start_is_listing") return { type: "noul", noul: 0.1 };
      if (name === "personal_data") return { type: "noul", noul: s.includes("phone") ? 0.91 : 0.03 };
      if (name === "members_only") return { type: "noul", noul: s.includes("your orders") ? 0.88 : 0.05 };
      if (name === "has_goal") return { type: "noul", noul: s.includes("laptop") ? 0.95 : 0.08 };
      if (name === "matches_request") return { type: "noul", noul: s.includes("pause") && s.includes("delete") ? 0.12 : 0.94 };
      if (name === "needs_review") return { type: "noul", noul: s.includes("every task") ? 0.9 : 0.1 };
      if (name === "narrow_scope") return { type: "noul", noul: s.includes("every task") ? 0.1 : 0.9 };
      if (name === "reversible") return { type: "noul", noul: s.includes("delete") ? 0.05 : 0.9 };
      if (name === "ambiguous") return { type: "noul", noul: 0.05 };
      return { type: "noul", noul: 0.8 };
    }
    if (q.type === "choice") {
      const opts = Object.keys(q.criteria as Record<string, unknown>);
      const pick = name === "page_kind" ? (s.includes("your orders") ? "account_area" : "listing") : opts[0]!;
      return { type: "choice", choice: pick, confidence: 0.9, probabilities: Object.fromEntries(opts.map((o) => [o, o === pick ? 0.9 : 0.1 / (opts.length - 1)])) };
    }
    const levels = q.criteria as string[];
    return { type: "score", score: levels.length - 1.2, confidence: 0.7, probabilities: Object.fromEntries(levels.map((_, i) => [String(i), i === levels.length - 1 ? 0.8 : 0.2 / (levels.length - 1)])), legend: Object.fromEntries(levels.map((l, i) => [String(i), l])) };
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const html = (status: number, body: string) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
      const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (url.pathname === "/robots.txt") return html(200, "User-agent: *\nDisallow: /private\n");
      if (url.pathname === "/") {
        return html(200, page("Gadget shop", `<nav><a href="/c/laptops">Laptops</a> <a href="/c/phones">Phones</a> <a href="/c/notebooks">Gaming notebooks</a> <a href="/c/cables">Cables</a></nav><main><h1>Welcome</h1><p>Deals every day.</p></main>`));
      }
      if (url.pathname.startsWith("/c/")) {
        const items = ["Lenovo IdeaPad laptop", "HP Pavilion laptop", "Dell Inspiron laptop"].map((n, i) => `<li class="item"><a class="name" href="/p/${i}">${n}</a><span class="price">₹${50 + i},999</span></li>`).join("");
        return html(200, page("Laptops", `<main><ul class="items">${items}</ul><a class="next" rel="next" href="${url.pathname}?page=2">Next</a></main>`));
      }
      if (url.pathname === "/account/orders") return html(200, page("Your orders", `<main><h1>Your orders</h1><p>Hello Priya. Order 4021 shipped to 14 Lake Road. Phone +91 98000 00012.</p><form><input type="password" name="pw"></form></main>`));
      if (url.pathname === "/private/data") return html(200, page("Private", "<p>secret</p>"));
      if (url.pathname === "/api/alpha/decisions") {
        const body = JSON.parse(raw) as DecisionBody;
        decisions.push({ body, auth: req.headers.authorization });
        const st = ctl.status.shift();
        if (st) return json(st, { error: { message: `forced ${st}` } });
        if (ctl.raw !== null) { res.writeHead(200, { "content-type": "application/json" }); res.end(ctl.raw); return; }
        const state = JSON.stringify(body.state);
        return json(200, {
          id: `gen-dec-${decisions.length}`, model: body.model, provider: "OpenAI",
          answers: Object.fromEntries(Object.entries(body.questions).map(([k, q]) => [k, answer(k, q, state)])),
          usage: { input_tokens: 1000, output_tokens: 0, cost: 0.0001 },
        });
      }
      if (url.pathname === "/api/v1/chat/completions") {
        const body = JSON.parse(raw) as { messages: { content: string }[] };
        const all = JSON.stringify(body.messages);
        chats.push(all);
        const content = all.includes("You plan a scrape")
          ? JSON.stringify({ start_is_listing: false, categories: [{ link: 4, name: "Cables" }], note: "chat pick" })
          : all.includes("CSS selectors")
            ? JSON.stringify({ itemSelector: "li.item", fields: [{ name: "name", selector: "a.name" }, { name: "price", selector: ".price" }, { name: "link", selector: "a.name", attr: "href" }] })
            : "ok";
        return json(200, { id: "c", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
      }
      html(404, page("Not found", "<p>nope</p>"));
    });
  });
  return new Promise<{ base: string; decisions: typeof decisions; chats: string[]; ctl: typeof ctl; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, decisions, chats, ctl, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

const world = await startWorld();
process.env.SCAPER_SCHEDULER = "off";
process.env.SCAPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scaper-decisions-"));

const { openDatabase, setDatabaseForTests } = await import("@/server/db");
setDatabaseForTests(openDatabase(":memory:"));
const { saveSettings, getSettings, publicSettings } = await import("@/server/repo/settings");
const { decide, decisionsUrl, decisionsTarget } = await import("@/server/ai/decisions");
const { checkScrape, scoreLinks, guardAction } = await import("@/server/ai/judge");
const { planCategoryScrape } = await import("@/server/ai/crawl");
const { candidateLinks } = await import("@/server/ai/crawl");
const { listAiCalls } = await import("@/server/repo/ai");
const { readAnswers, guardVerdict, combineFindings, aiScrapeFindings, DESTRUCTIVE_TOOL } = await import("@/lib/decision-policy");
const { dispatcherFor } = await import("@/server/fetcher/http");
const { withWork } = await import("@/server/privacy");
const { Socks5ProxyAgent, ProxyAgent } = await import("undici");

const decisionsOn = (patch: Record<string, unknown> = {}) => saveSettings({
  ai: {
    providers: [{ id: "openrouter", name: "OpenRouter", baseUrl: `${world.base}/api/v1`, apiKey: "sk-or-test-123456", auth: "bearer", headers: [], models: [{ id: "chat-model", contextWindow: null, inputPrice: 0, outputPrice: 0, tools: true, json: true }], timeoutSeconds: 30, enabled: true }],
    main: { providerId: "openrouter", model: "chat-model" },
    dailyRequestLimit: 500,
    decisions: { ...getSettings().ai.decisions, enabled: true, providerId: "openrouter", model: "openai/gpt-6-luna-decisions", ...patch },
  },
});

beforeAll(() => {
  saveSettings({ scraping: { allowPrivateNetwork: true, minDelaySeconds: 1, respectRobots: true } });
  decisionsOn();
});
beforeEach(() => { world.ctl.status = []; world.ctl.raw = null; });
afterAll(async () => { await world.close(); });

describe("decision policy (plain code, no model)", () => {
  const qs = {
    urgent: { type: "noul" as const, instructions: "Urgent?" },
    team: { type: "choice" as const, instructions: "Team?", criteria: { billing: null, technical: null, other: null } },
    depth: { type: "score" as const, instructions: "Depth?", criteria: ["None", "Some", "Deep"] },
  };

  it("reads yes, no and unsure against the threshold, and asks a person when unsure", () => {
    const clear = readAnswers(qs, {
      urgent: { type: "noul", noul: 0.92 },
      team: { type: "choice", choice: "billing", probabilities: { billing: 0.85, technical: 0.1, other: 0.05 }, confidence: 0.8 },
      depth: { type: "score", score: 1.9, probabilities: { 0: 0, 1: 0.1, 2: 0.9 }, confidence: 0.8, legend: null },
    }, 0.8);
    expect(clear.outcome).toBe("clear");
    expect(clear.lines.map((l) => l.verdict)).toEqual(["yes", "billing", "Deep"]);

    const unsure = readAnswers(qs, { urgent: { type: "noul", noul: 0.6 }, team: { type: "choice", choice: "billing", probabilities: { billing: 0.55, technical: 0.45, other: 0 }, confidence: 0.1 } }, 0.8);
    expect(unsure.outcome).toBe("needs_review");
    expect(unsure.lines[0]).toMatchObject({ verdict: "unsure", sure: false });
    expect(unsure.lines[1]).toMatchObject({ verdict: "unsure", sure: false });
    expect(unsure.lines[2]).toMatchObject({ verdict: "no answer" });
    expect(readAnswers({ urgent: qs.urgent }, { urgent: { type: "noul", noul: 0.1 } }, 0.8).lines[0]!.verdict).toBe("no");
    // The threshold boundary counts.
    expect(readAnswers({ urgent: qs.urgent }, { urgent: { type: "noul", noul: 0.8 } }, 0.8).lines[0]!.verdict).toBe("yes");
  });

  it("guardrail: deleting always asks, a failed check asks, and the model can only add reasons", () => {
    const calm = { matchesRequest: 0.99, narrowScope: 0.99, reversible: 0.99, ambiguous: 0.01, needsReview: 0.01 };
    expect(guardVerdict({ destructive: true, signals: calm }, 0.5).ask).toBe(true);
    expect(guardVerdict({ destructive: false, signals: calm }, 0.5)).toEqual({ ask: false, reasons: [] });
    expect(guardVerdict({ destructive: false, signals: null, error: "timeout" }, 0.5).ask).toBe(true);
    const off = guardVerdict({ destructive: false, signals: { ...calm, matchesRequest: 0.1 } }, 0.5);
    expect(off.ask).toBe(true);
    expect(off.reasons[0]).toMatch(/not be what you asked/);
    expect(guardVerdict({ destructive: false, signals: { ...calm, needsReview: 0.7 } }, 0.5).ask).toBe(true);
    expect(["delete_task", "delete_watcher", "untrack_product", "forget"].every((n) => DESTRUCTIVE_TOOL.test(n))).toBe(true);
    expect(["create_task", "remember", "run_task"].some((n) => DESTRUCTIVE_TOOL.test(n))).toBe(false);
  });

  it("scrape findings: a rule's stop always wins and the model never says stop", () => {
    expect(combineFindings([{ level: "stop", source: "rule", text: "robots" }, { level: "ok", source: "ai", text: "fine" }])).toBe("stop");
    const ai = aiScrapeFindings({ personalData: 0.99, membersOnly: 0.99, kind: "checkout", kindP: 0.99, hasGoal: 0.01, goal: "x" }, 0.5);
    expect(ai.every((f) => f.level !== "stop")).toBe(true);
    expect(combineFindings(ai)).toBe("caution");
    expect(aiScrapeFindings({ personalData: 0.4 }, 0.5)).toEqual([]);
  });
});

describe("decisions client", () => {
  it("derives OpenRouter's decisions endpoint from the chat base URL", () => {
    expect(decisionsUrl("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(decisionsUrl("https://openrouter.ai/api/v1/chat/completions")).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(decisionsTarget()?.url).toBe(`${world.base}/api/alpha/decisions`);
  });

  it("sends model, state and questions with the key, validates answers, logs and counts the cost", async () => {
    const r = await decide({
      state: "Payouts failed for three days; payroll is due today.",
      questions: { is_urgent: { type: "noul", instructions: "Urgent?", criteria: { true: "deadline", false: "none" } }, team: { type: "choice", instructions: "Team?", criteria: { billing: "Payments", technical: null, other: null } }, depth: { type: "score", instructions: "How bad?", criteria: ["Low", "Mid", "High"] } },
      purpose: "test",
    });
    const sent = world.decisions.at(-1)!;
    expect(sent.auth).toBe("Bearer sk-or-test-123456");
    expect(sent.body.model).toBe("openai/gpt-6-luna-decisions");
    expect(Object.keys(sent.body.questions)).toEqual(["is_urgent", "team", "depth"]);
    expect(r.answers.is_urgent).toEqual({ type: "noul", noul: 0.8 });
    expect(r.answers.team).toMatchObject({ type: "choice", choice: "billing" });
    expect(r.answers.depth).toMatchObject({ type: "score", legend: { 0: "Low", 1: "Mid", 2: "High" } });
    expect(r.usage).toEqual({ inputTokens: 1000, outputTokens: 0, cost: 0.0001 });
    expect(listAiCalls({ purpose: "decide:test" }).items[0]).toMatchObject({ purpose: "decide:test", status: "ok", model: "openai/gpt-6-luna-decisions" });
  });

  it("retries rate limits, but not a refused key; rejects bad answers and bad questions", async () => {
    world.ctl.status = [429];
    await expect(decide({ state: "x", questions: { a: { type: "noul", instructions: "?" } }, purpose: "test" })).resolves.toMatchObject({ answers: { a: { type: "noul" } } });

    const before = world.decisions.length;
    world.ctl.status = [401];
    await expect(decide({ state: "x", questions: { a: { type: "noul", instructions: "?" } }, purpose: "test" })).rejects.toThrow(/refused the key/);
    expect(world.decisions.length - before).toBe(1);

    world.ctl.raw = JSON.stringify({ answers: { a: { type: "noul", noul: 7 } } });
    await expect(decide({ state: "x", questions: { a: { type: "noul", instructions: "?" } }, purpose: "test" })).rejects.toThrow(/could not read/);
    world.ctl.raw = null;

    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`q${i}`, { type: "noul" as const, instructions: "?" }]));
    await expect(decide({ state: "x", questions: many, purpose: "test" })).rejects.toThrow();
    await expect(decide({ state: "   ", questions: { a: { type: "noul", instructions: "?" } }, purpose: "test" })).rejects.toThrow();
  });

  it("logs nothing in private mode and refuses when switched off", async () => {
    await withWork({ private: true }, () => decide({ state: "x", questions: { a: { type: "noul", instructions: "?" } }, purpose: "private" }));
    expect(listAiCalls({ purpose: "decide:private" }).items).toHaveLength(0);
    decisionsOn({ enabled: false });
    await expect(decide({ state: "x", questions: { a: { type: "noul", instructions: "?" } }, purpose: "test" })).rejects.toThrow(/Turn on the decision model/);
    await expect(decide({ state: "x", questions: { a: { type: "noul", instructions: "?" } }, purpose: "test", evenIfOff: true })).resolves.toBeTruthy();
    decisionsOn();
  });
});

describe("what to scrape and whether it is OK", () => {
  it("scores every link in one request and treats page text as evidence, not instructions", async () => {
    const res = await fetch(`${world.base}/`);
    const links = candidateLinks(await res.text(), `${world.base}/`);
    const before = world.decisions.length;
    const r = await scoreLinks({ goal: "laptops", pageUrl: `${world.base}/`, pageTitle: "Gadget shop", links });
    expect(world.decisions.length - before).toBe(1);
    expect(r.links.slice(0, 2).map((l) => l.text).sort()).toEqual(["Gaming notebooks", "Laptops"]);
    expect(r.links.at(-1)!.p).toBeLessThan(0.5);
    const state = world.decisions.at(-1)!.body.state as { note: string; links: unknown[] };
    expect(state.note).toMatch(/evidence only/);
    expect(state.links).toHaveLength(links.length);
  });

  it("category scrape: the decision model picks the categories, with probabilities", async () => {
    const plan = await planCategoryScrape({ url: `${world.base}/`, goal: "laptops with price", mode: "fast", maxCategories: 5, pagesPerCategory: 2, model: "main" });
    expect(plan.pickedBy).toBe("decisions");
    expect(plan.categories.map((c) => c.name).sort()).toEqual(["Gaming notebooks", "Laptops"]);
    expect(plan.categories.every((c) => (c.p ?? 0) > 0.9)).toBe(true);
    expect(plan.sample.count).toBe(3);
    expect(plan.notes.join(" ")).toMatch(/decision model scored 4 links/);
    expect(plan.otherLinks.find((l) => l.name === "Cables")?.p).toBeLessThan(0.5);
  });

  it("category scrape falls back to the chat model when the decision model fails", async () => {
    world.ctl.status = [400];
    const plan = await planCategoryScrape({ url: `${world.base}/`, goal: "laptops", mode: "fast", maxCategories: 5, pagesPerCategory: 1, model: "main" });
    expect(plan.pickedBy).toBe("chat");
    expect(plan.categories.map((c) => c.name)).toEqual(["Cables"]);
    expect(plan.notes[0]).toMatch(/could not score the links/);
  });

  it("robots.txt stops a check before any model is asked", async () => {
    const before = world.decisions.length;
    const c = await checkScrape({ url: `${world.base}/private/data` });
    expect(c.outcome).toBe("stop");
    expect(c.findings[0]).toMatchObject({ level: "stop", source: "rule" });
    expect(c.findings[0]!.text).toMatch(/robots\.txt/);
    expect(world.decisions.length).toBe(before);
  });

  it("an account page with personal data gets cautions from the rules and the model", async () => {
    const c = await checkScrape({ url: `${world.base}/account/orders` });
    expect(c.outcome).toBe("caution");
    const texts = c.findings.map((f) => `${f.source}:${f.text}`).join("\n");
    expect(texts).toMatch(/rule:.*account or checkout/);
    expect(texts).toMatch(/rule:.*password field/);
    expect(texts).toMatch(/ai:Personal details/);
    expect(texts).toMatch(/ai:This looks like members-only/);
    expect(c.kind).toMatchObject({ value: "account_area", label: "Account area" });
  });

  it("a public listing with what you asked for is OK", async () => {
    const c = await checkScrape({ url: `${world.base}/c/laptops`, goal: "laptops" });
    expect(c.outcome).toBe("ok");
    expect(c.findings.some((f) => f.source === "ai" && f.level === "ok")).toBe(true);
    expect(c.kind?.value).toBe("listing");
    expect(c.richness?.label).toBe("Rich, repeated structured data");
  });

  it("without the decision model the check still runs on rules", async () => {
    decisionsOn({ enabled: false });
    const c = await checkScrape({ url: `${world.base}/account/orders` });
    expect(c.outcome).toBe("caution");
    expect(c.ai).toBeNull();
    expect(c.findings.every((f) => f.source === "rule")).toBe(true);
    decisionsOn();
  });
});

describe("agent guardrail", () => {
  it("flags an action that does not match the request, and always asks before deleting", async () => {
    const del = await guardAction({ request: "Pause my laptop watcher for a week", tool: "delete_watcher", summary: "Delete watcher Laptop prices", args: { id: "w1" }, destructive: true });
    expect(del.ask).toBe(true);
    expect(del.reasons.join(" ")).toMatch(/deletes something/);
    expect(del.reasons.join(" ")).toMatch(/not be what you asked/);
    expect(del.signals?.matchesRequest).toBeLessThan(0.5);

    const fine = await guardAction({ request: "Watch example.com for changes", tool: "create_watcher", summary: "Create watcher example.com", args: { url: "https://example.com" }, destructive: false });
    expect(fine).toMatchObject({ ask: false, reasons: [] });

    const broad = await guardAction({ request: "Tidy up", tool: "set_task_schedule", summary: "Set every task to run each minute", args: {}, destructive: false });
    expect(broad.ask).toBe(true);
  });

  it("a guard that cannot reach the model asks instead of going ahead", async () => {
    world.ctl.status = [401];
    const g = await guardAction({ request: "Watch example.com", tool: "create_watcher", summary: "Create watcher", args: {}, destructive: false });
    expect(g.ask).toBe(true);
    expect(g.error).toMatch(/refused the key/);
  });
});

describe("network and VPN", () => {
  it("uses a SOCKS5 proxy (a VPN app's local proxy) or an HTTP proxy as given", () => {
    expect(dispatcherFor("socks5://127.0.0.1:1080")).toBeInstanceOf(Socks5ProxyAgent);
    expect(dispatcherFor("socks5h://127.0.0.1:1081")).toBeInstanceOf(Socks5ProxyAgent);
    expect(dispatcherFor("http://127.0.0.1:8080")).toBeInstanceOf(ProxyAgent);
  });

  it("keeps the saved proxy password when the form sends it back masked, and rejects other schemes", () => {
    saveSettings({ scraping: { proxyUrl: "socks5://me:secret@127.0.0.1:1080" } });
    const masked = publicSettings(getSettings()).scraping.proxyUrl;
    expect(masked).toBe("socks5://••••@127.0.0.1:1080");
    saveSettings({ scraping: { proxyUrl: masked, proxyAi: true } });
    expect(getSettings().scraping).toMatchObject({ proxyUrl: "socks5://me:secret@127.0.0.1:1080", proxyAi: true });
    expect(() => saveSettings({ scraping: { proxyUrl: "ftp://x" } })).toThrow();
    saveSettings({ scraping: { proxyUrl: "", proxyAi: false } });
  });
});
