import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "./fixture-server";
import { startMockLlm } from "./mock-llm";

type Msg = { role: string; content: string | null };
const call = (name: string, args: Record<string, unknown>) => ({ content: null, tool_calls: [{ id: `c-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
let siteBase = "";
const reviews: string[] = [];

/** The agent learns a site, then a reviewer scores the run; both are scripted by who is asking. */
function script(messages: Msg[]) {
  const sys = messages[0]?.content ?? "";
  if (sys.includes("You review the work of Scaper's AI agent")) {
    reviews.push(messages[1]?.content ?? "");
    return { content: JSON.stringify({
      score: 4, summary: "Found the cheapest item in two steps.", problems: ["Read the guide even though the request was simple."],
      lesson: "Try extract_items before reading the whole page with read_page.",
      note: { name: "fixture-listing", title: "Fixture shop listing", kind: "site", markdown: "## Listing\n- extract_items finds the products on /listing.\n- Prices are in rupees." },
    }) };
  }
  const tools = messages.filter((m) => m.role === "tool").length;
  const first = messages.find((m) => m.role === "user")?.content ?? "";
  if (first.includes("learn the shop")) {
    return [
      call("app_guide", { topic: "scraping" }),
      call("read_page", { url: `${siteBase}/listing` }),
      call("write_note", { name: "shop-howto", title: "How I read the fixture shop", kind: "how-to", markdown: "1. read_page on /listing\n2. Report the cheapest item." }),
      { content: "The cheapest item is listed. I wrote a note for next time." },
    ][Math.min(tools, 3)]!;
  }
  if (first.includes("leak")) return tools === 0 ? call("write_note", { title: "Keys", markdown: "My key is sk-abcdefghijklmnopqrstuvwxyz123456" }) : { content: "ok" };
  if (first.includes("private note")) return tools === 0 ? call("write_note", { title: "Secret plan", markdown: "Something to keep." }) : { content: "ok" };
  return { content: "Hello." };
}

process.env.SCAPER_SCHEDULER = "off";
process.env.SCAPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scaper-knowledge-"));
const { openDatabase, setDatabaseForTests } = await import("@/server/db");
setDatabaseForTests(openDatabase(":memory:"));
const { saveSettings, getSettings } = await import("@/server/repo/settings");
const { startAgent, buildSystemPrompt } = await import("@/server/ai/agent");
const { getAgentRun } = await import("@/server/repo/agent");
const kn = await import("@/server/repo/knowledge");
const guide = await import("@/server/ai/knowledge");
const { TOOLS } = await import("@/server/ai/tools");
const { HELPER_TOOLS, SUPERVISOR_TOOL_NAMES } = await import("@/server/ai/team");
const { ALL_NAV } = await import("@/components/nav");

let site: Awaited<ReturnType<typeof startFixtureServer>>;
let llm: Awaited<ReturnType<typeof startMockLlm>>;

beforeAll(async () => {
  site = await startFixtureServer();
  siteBase = site.base;
  llm = await startMockLlm(script);
  saveSettings({
    scraping: { allowPrivateNetwork: true, minDelaySeconds: 1 },
    ai: {
      providers: [{ id: "p", name: "Mock", baseUrl: llm.base, apiKey: "k", auth: "bearer", headers: [], timeoutSeconds: 30, enabled: true, models: [{ id: "big", contextWindow: 1_000_000, inputPrice: 0, outputPrice: 0, tools: true, json: true }, { id: "small", contextWindow: null, inputPrice: 0, outputPrice: 0, tools: true, json: true }] }],
      main: { providerId: "p", model: "big" }, fast: { providerId: "p", model: "small" }, dailyRequestLimit: 1000, agentApproval: "ask",
    },
  });
});
afterAll(async () => { await site.close(); await llm.close(); });

async function finished(id: string) {
  const until = Date.now() + 20_000;
  for (;;) {
    const r = getAgentRun(id)!;
    if (r.status !== "running") return r;
    if (Date.now() > until) throw new Error("still running");
    await new Promise((res) => setTimeout(res, 40));
  }
}
async function reviewed(id: string) {
  const until = Date.now() + 10_000;
  while (!kn.getReview(id) && Date.now() < until) await new Promise((r) => setTimeout(r, 40));
  return kn.getReview(id);
}

describe("the guide covers the whole app, and new features must be added to it", () => {
  it("every page has help, every tool a description, every topic real text", () => {
    expect(guide.guideGaps()).toEqual({ pages: [], tools: [], topics: [] });
    for (const item of ALL_NAV) expect(guide.PAGE_HELP[item.href], `help for ${item.href}`).toBeTruthy();
  });

  it("lists every tool (team tools included) and every page, read from the app itself", () => {
    const tools = guide.readGuide({ topic: "tools" });
    for (const name of [...Object.keys(TOOLS), ...SUPERVISOR_TOOL_NAMES]) expect(tools, name).toContain(`- ${name}`);
    const pages = guide.readGuide({ topic: "pages" });
    for (const item of ALL_NAV) expect(pages).toContain(`(${item.href})`);
  });

  it("goes into every system prompt with the live set-up, and can be switched off", () => {
    const sys = buildSystemPrompt({ private: false, approval: "ask" });
    expect(sys).toContain("Scaper guide (always current)");
    expect(sys).toContain("Main model: Mock · big (1,000,000 tokens)");
    expect(sys).toMatch(/Scraping browser: (ready|not installed)/);
    expect(sys).toContain("Knowledge: app_guide, list_notes, read_note, write_note, delete_note");
    saveSettings({ ai: { learning: { ...getSettings().ai.learning, guide: false } } });
    expect(buildSystemPrompt({ private: false, approval: "ask" })).not.toContain("Scaper guide");
    saveSettings({ ai: { learning: { ...getSettings().ai.learning, guide: true } } });
  });

  it("answers by topic, by search and by note name", () => {
    expect(guide.readGuide({})).toMatch(/^Topics/);
    expect(guide.readGuide({ topic: "team" })).toContain("spawn_agents");
    expect(guide.readGuide({ query: "robots captcha" })).toContain("Rules you never break");
    expect(guide.readGuide({ query: "zzzz qqqq" })).toMatch(/Nothing in the guide/);
  });
});

describe("notes", () => {
  it("are saved as versioned Markdown and mirrored to .md files", () => {
    const n = kn.saveNote({ title: "Books site", kind: "site", body: "Use .product_pod" });
    expect(n.name).toBe("books-site");
    const file = path.join(kn.knowledgeDir(), "books-site.md");
    expect(fs.readFileSync(file, "utf8")).toMatch(/^---\ntitle: "Books site"\nkind: site\nversion: 1[\s\S]*Use \.product_pod\n$/);
    expect(kn.saveNote({ title: "Books site", body: "Use article.product_pod" }).version).toBe(2);
    expect(fs.readFileSync(file, "utf8")).toContain("version: 2");
    expect(guide.readGuide({ topic: "books-site" })).toContain("article.product_pod");
    expect(kn.deleteNote("books-site")).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("keep lessons short, newest first and without repeats", () => {
    kn.addLesson("Check robots.txt before planning a category scrape.");
    kn.addLesson("Use extract_items first; it costs no AI tokens.");
    kn.addLesson("use extract_items first, it costs no AI tokens");
    expect(kn.lessons()).toEqual(["Use extract_items first; it costs no AI tokens.", "Check robots.txt before planning a category scrape."]);
  });

  it("helpers can read the guide and notes but not write them", () => {
    expect(HELPER_TOOLS).toEqual(expect.arrayContaining(["app_guide", "list_notes", "read_note"]));
    expect(HELPER_TOOLS).not.toContain("write_note");
    expect(HELPER_TOOLS).not.toContain("delete_note");
    expect(TOOLS.delete_note!.changes).toBe(true);
  });
});

describe("the agent learns from its own work", () => {
  it("reads the guide, writes a note, then reviews the job and keeps the lesson for next time", async () => {
    const run = await finished(startAgent({ prompt: "Please learn the shop and find the cheapest item", model: "main" }).id);
    expect(run.status).toBe("done");
    expect(run.steps.filter((s) => s.type === "tool").map((s) => s.type === "tool" && [s.name, s.ok])).toEqual([["app_guide", true], ["read_page", true], ["write_note", true]]);
    expect(kn.getNote("shop-howto")?.body).toContain("read_page on /listing");

    const review = await reviewed(run.id);
    expect(review).toMatchObject({ score: 4, note_name: "fixture-listing", lesson: "Try extract_items before reading the whole page with read_page." });
    expect(kn.getNote("fixture-listing")).toMatchObject({ kind: "site", source: "agent" });
    // The reviewer sees which tools ran, never the page's own text.
    expect(reviews.at(-1)).toContain("read_page(");
    expect(reviews.at(-1)).not.toContain("Headphones");

    const next = buildSystemPrompt({ private: false, approval: "ask" });
    expect(next).toContain("- Try extract_items before reading the whole page with read_page.");
    expect(next).toContain("shop-howto (how-to)");
    expect(next).toContain("fixture-listing (site)");
  });

  it("a review adds to an existing note instead of replacing it", async () => {
    const before = kn.getNote("fixture-listing")!.body;
    const run = await finished(startAgent({ prompt: "Please learn the shop again", model: "main" }).id);
    await reviewed(run.id);
    const after = kn.getNote("fixture-listing")!;
    expect(after.body.startsWith(before)).toBe(true);
    expect(after.body).toMatch(/## Update \d{4}-\d{2}-\d{2}/);
    expect(after.version).toBe(2);
  });

  it("never stores secrets, and private conversations write nothing", async () => {
    const leak = await finished(startAgent({ prompt: "leak my key", model: "main" }).id);
    expect(leak.steps[0]).toMatchObject({ type: "tool", name: "write_note", ok: false });
    expect(kn.getNote("keys")).toBeNull();

    const priv = await finished(startAgent({ prompt: "private note please", model: "main", private: true }).id);
    expect(priv.steps[0]).toMatchObject({ type: "tool", ok: false });
    expect(kn.getNote("secret-plan")).toBeNull();
    await new Promise((r) => setTimeout(r, 300));
    expect(kn.getReview(priv.id)).toBeNull();
  });

  it("simple questions are not reviewed", async () => {
    const n = reviews.length;
    const run = await finished(startAgent({ prompt: "hi", model: "main" }).id);
    await new Promise((r) => setTimeout(r, 300));
    expect(kn.getReview(run.id)).toBeNull();
    expect(reviews.length).toBe(n);
  });
});
