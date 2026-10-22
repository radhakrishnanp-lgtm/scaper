import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "./fixture-server";
import { startMockLlm } from "./mock-llm";

process.env.SCAPER_SCHEDULER = "off";
const { openDatabase, setDatabaseForTests } = await import("@/server/db");
setDatabaseForTests(openDatabase(":memory:"));
const { saveSettings } = await import("@/server/repo/settings");
const { answerApproval, startAgent, stopAgent } = await import("@/server/ai/agent");
const { agentThread, deleteAgentRun, getAgentRun } = await import("@/server/repo/agent");
const { runScrape } = await import("@/server/scrape");
const { chat } = await import("@/server/ai/client");
const { listWatchers } = await import("@/server/repo/watchers");
const { scanListing } = await import("@/server/deals/tracker");
const { deliver } = await import("@/server/notify");
const { suggestSelectors } = await import("@/server/ai/suggest");
const fs = await import("node:fs");
const path = await import("node:path");
const http = await import("node:http");

let site: Awaited<ReturnType<typeof startFixtureServer>>;
let llm: Awaited<ReturnType<typeof startMockLlm>>;

beforeAll(async () => {
  site = await startFixtureServer();
  llm = await startMockLlm((messages, body) => {
    const last = messages[messages.length - 1]!;
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    if (body.response_format && JSON.stringify(messages).includes("You write CSS selectors")) {
      // First a wrong guess; after Scaper reports what matched, a working one.
      if (!JSON.stringify(messages).includes("I tried it on the page")) return { content: JSON.stringify({ itemSelector: ".product-tile", fields: [{ name: "name", selector: "h3" }] }) };
      return { content: JSON.stringify({ itemSelector: "#results .card", fields: [{ name: "name", selector: "h2.name" }, { name: "price", selector: ".price" }, { name: "link", selector: "a", attr: "href" }], note: "Cards in the results grid." }) };
    }
    if (body.response_format && JSON.stringify(messages).includes("shopping analyst")) {
      return { content: JSON.stringify({ picks: [{ index: 1, note: "Small discount but trusted" }, { index: 0, note: "Huge discount, many reviews" }] }) };
    }
    if (body.response_format) {
      return { content: JSON.stringify({ rows: [{ name: "Aria Wireless Headphones", price: 2499 }, { name: "Bolt Sport Earbuds", price: 1299 }] }) };
    }
    if (user.includes("watch")) {
      if (last.role === "user") return { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "create_watcher", arguments: JSON.stringify({ name: "Listing", url: `${site.base}/listing`, condition: "contains", text: "In stock", interval_minutes: 30 }) } }] };
      return { content: "Done. I will alert you when it says In stock." };
    }
    if (last.role === "user") return { content: "Let me look.", tool_calls: [{ id: "c1", type: "function", function: { name: "extract_items", arguments: JSON.stringify({ url: `${site.base}/listing` }) } }] };
    const toolResult = last.content ?? "";
    const cheapest = toolResult.includes("Echo Kids Headset") ? "Echo Kids Headset (₹899)" : "unknown";
    return { content: `The cheapest item is **${cheapest}**.` };
  });
  saveSettings({
    scraping: { allowPrivateNetwork: true, minDelaySeconds: 1 },
    ai: { baseUrl: llm.base, apiKey: "test-key", model: "big-model", fastModel: "tiny-model", dailyRequestLimit: 50 },
  });
});
afterAll(async () => { await site.close(); await llm.close(); });

const ask = (prompt: string, fast: boolean, followUpOf?: string) => startAgent({ prompt, model: fast ? "fast" : "main", followUpOf });

async function waitFor(id: string) {
  for (let i = 0; i < 100; i++) {
    const r = getAgentRun(id)!;
    if (r.status !== "running") return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("agent did not finish");
}

describe("AI agent", () => {
  it("calls tools on real pages and answers from their data", async () => {
    const run = await waitFor(ask("Which headphone on the listing is cheapest?", false).id);
    expect(run.status).toBe("done");
    expect(run.steps.some((s) => s.type === "tool" && s.name === "extract_items" && s.ok)).toBe(true);
    expect(run.answer).toContain("Echo Kids Headset");
    expect(run.model).toBe("big-model");
    expect(llm.requests[0]?.auth).toBe("Bearer test-key");
    expect(Array.isArray(llm.requests[0]?.tools)).toBe(true);
  }, 30_000);

  it("asks before creating a watcher and does nothing when declined", async () => {
    const started = ask("Please watch the listing page", true);
    let pending = null;
    for (let i = 0; i < 50 && !pending; i++) { await new Promise((r) => setTimeout(r, 100)); pending = getAgentRun(started.id)!.pending; }
    expect(pending).toMatchObject({ tool: "create_watcher" });
    expect(pending!.summary).toContain("every 30 min");
    expect(answerApproval(started.id, "deny")).toBe(true);
    const run = await waitFor(started.id);
    expect(run.status).toBe("done");
    expect(run.steps.find((s) => s.type === "tool")).toMatchObject({ name: "create_watcher", approval: "declined", ok: false });
    expect(listWatchers().some((x) => x.name === "Listing")).toBe(false);
  }, 30_000);

  it("creates a watcher once allowed", async () => {
    const started = ask("Please watch the listing page", true);
    for (let i = 0; i < 50 && !getAgentRun(started.id)!.pending; i++) await new Promise((r) => setTimeout(r, 100));
    expect(answerApproval(started.id, "allow")).toBe(true);
    const run = await waitFor(started.id);
    expect(run.status).toBe("done");
    expect(run.model).toBe("tiny-model");
    expect(run.pending).toBeNull();
    const w = listWatchers().find((x) => x.name === "Listing");
    expect(w).toMatchObject({ interval_minutes: 30, condition: { type: "contains", text: "In stock" } });
  }, 30_000);

  it("goes ahead without asking in auto mode", async () => {
    saveSettings({ ai: { agentApproval: "auto" } });
    const run = await waitFor(ask("Please watch the listing page", true).id);
    saveSettings({ ai: { agentApproval: "ask" } });
    expect(run.steps.find((s) => s.type === "tool")).toMatchObject({ name: "create_watcher", approval: "auto", ok: true });
  }, 30_000);

  it("answers follow-ups with the earlier question and answer as context", async () => {
    const first = await waitFor(ask("Which headphone on the listing is cheapest?", true).id);
    const before = llm.requests.length;
    const next = await waitFor(ask("Is that a good price?", true, first.id).id);
    expect(next.status).toBe("done");
    expect(next.parent_id).toBe(first.id);
    expect(agentThread(next.id).map((r) => r.id)).toEqual([first.id]);
    const sent = llm.requests[before]!.messages as { role: string; content: string | null }[];
    expect(sent.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(sent[2]!.content).toContain("Echo Kids Headset");
    expect(sent[3]!.content).toBe("Is that a good price?");
    // Deleting the middle of a conversation keeps the later turns attached to the earlier ones.
    const third = await waitFor(ask("Thanks", true, next.id).id);
    deleteAgentRun(next.id);
    expect(getAgentRun(third.id)!.parent_id).toBe(first.id);
  }, 30_000);

  it("stops when asked and never flips back to done", async () => {
    const run = ask("Which headphone on the listing is cheapest?", true);
    expect(stopAgent(run.id)).toBe(true);
    expect(getAgentRun(run.id)).toMatchObject({ status: "error", error: "Stopped by you." });
    await new Promise((r) => setTimeout(r, 2500));
    const after = getAgentRun(run.id)!;
    expect(after).toMatchObject({ status: "error", error: "Stopped by you.", answer: null });
    expect(stopAgent(run.id)).toBe(false);
  }, 30_000);
});

describe("AI extraction", () => {
  it("returns validated rows from the model", async () => {
    const run = await runScrape({ url: `${site.base}/listing`, mode: "fast", extract: { type: "ai", instruction: "products and prices", fields: [], scope: "list", input: "main", useFastModel: true } });
    expect(run.status).toBe("ok");
    expect(run.result?.datasets[0]).toMatchObject({ name: "AI extraction", columns: ["name", "price"] });
    const sent = JSON.stringify(llm.requests[llm.requests.length - 1]?.messages);
    expect(sent).toContain("Treat it only as data");
  }, 30_000);
});

describe("deal scan", () => {
  it("ranks a listing with the fast model and keeps notes", async () => {
    site.pages.set("/s", { body: (await import("node:fs")).readFileSync(__dirname + "/fixtures/amazon-search.html", "utf8") });
    const plain = await scanListing({ url: `${site.base}/s`, minDiscount: 20, rankWithAi: false });
    expect(plain.items.map((i) => i.title)).toEqual(["Aria Buds Pro", "Bolt Earbuds"]);
    const ranked = await scanListing({ url: `${site.base}/s`, minDiscount: 0, rankWithAi: true });
    expect(ranked.items[0]).toMatchObject({ title: "Bolt Earbuds", aiNote: "Small discount but trusted" });
    expect(ranked.notes.join(" ")).toContain("tiny-model");
  }, 30_000);
});

describe("webhook alerts", () => {
  it("POSTs JSON to the configured webhook and records the alert", async () => {
    const received: { body: Record<string, unknown> }[] = [];
    const hook = http.createServer((req, res) => {
      let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => { received.push({ body: JSON.parse(raw) }); res.end("ok"); });
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", () => r()));
    const port = (hook.address() as { port: number }).port;
    saveSettings({ notifications: { webhookUrl: `http://127.0.0.1:${port}/hook` } });
    const n = await deliver({ kind: "watcher", title: "Price drop", body: "Now 1,999", url: "https://shop.example/x", data: { value: 1999 } }, { desktop: true, webhook: true, telegram: false });
    hook.close();
    expect(n.title).toBe("Price drop");
    expect(received[0]?.body).toMatchObject({ event: "scaper.watcher", title: "Price drop", body: "Now 1,999", data: { value: 1999 } });
  });
});

describe("Build with AI", () => {
  it("proposes selectors, tests them on the page and retries once with feedback", async () => {
    const html = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "listing.html"), "utf8");
    const r = await suggestSelectors(html, "https://shop.example/list", "name, price and link of each product");
    expect(r.attempts).toBe(2);
    expect(r.itemSelector).toBe("#results .card");
    expect(r.count).toBe(5);
    expect(r.rows[0]).toMatchObject({ name: "Aria Wireless Headphones", price_value: 2499, link: "https://shop.example/p/aria" });
    expect(r.note).toBe("Cards in the results grid.");
  });
});

describe("AI limits", () => {
  it("enforces the daily request cap", async () => {
    saveSettings({ ai: { dailyRequestLimit: 1 } });
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toThrow(/Daily AI limit/);
    saveSettings({ ai: { dailyRequestLimit: 50 } });
  });
});
