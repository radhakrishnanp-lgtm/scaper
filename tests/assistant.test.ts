import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startFixtureServer } from "./fixture-server";
import { startMockLlm } from "./mock-llm";

process.env.SCAPER_SCHEDULER = "off";
process.env.SCAPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scaper-assistant-"));
vi.setConfig({ testTimeout: 60_000 });

const { openDatabase, setDatabaseForTests } = await import("@/server/db");
setDatabaseForTests(openDatabase(":memory:"));
const { saveSettings } = await import("@/server/repo/settings");
const { TOOLS } = await import("@/server/ai/tools");
const { getAgentRun } = await import("@/server/repo/agent");
const { addNotification, listNotifications, unreadCount } = await import("@/server/repo/notifications");
const { createWatcher, getWatcher } = await import("@/server/repo/watchers");
const { createProduct, getProduct } = await import("@/server/repo/products");
const { listDownloads } = await import("@/server/repo/downloads");
const { watcherSchema } = await import("@/lib/schemas");
const assistant = await import("@/app/api/assistant/route");

type Msg = { role: string; content: string | null; tool_calls?: unknown[] };
let site: Awaited<ReturnType<typeof startFixtureServer>>;
let llm: Awaited<ReturnType<typeof startMockLlm>>;
const seen: Msg[][] = [];
const call = (name: string, args: unknown) => ({ content: null, tool_calls: [{ id: `c${Math.random()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

beforeAll(async () => {
  site = await startFixtureServer();
  site.pages.set("/files/manual.pdf", { body: "%PDF-1.4 manual", type: "application/pdf" });
  site.pages.set("/item/9", { body: `<html><body><h1>Item 9</h1><a href="/files/guide-9.pdf">Download the guide</a></body></html>` });
  site.pages.set("/files/guide-9.pdf", { body: "%PDF-1.4 guide", type: "application/pdf" });
  // The "AI": checks the links in the rows, downloads the file, looks inside the page for its file, downloads that, answers.
  llm = await startMockLlm((messages) => {
    seen.push(messages);
    const tools = messages.filter((m) => m.role === "tool").length;
    const user = String(messages.find((m) => m.role === "user")?.content ?? "");
    if (!user.includes("<rows>")) return { content: "Nothing selected." };
    if (tools === 0) return call("check_links", { urls: [`${site.base}/files/manual.pdf`, `${site.base}/item/9`] });
    if (tools === 1) return call("download_files", { urls: [`${site.base}/files/manual.pdf`], folder: "From rows" });
    if (tools === 2) return call("find_files", { urls: [`${site.base}/item/9`], kinds: ["pdf"], depth: 0 });
    if (tools === 3) return call("download_files", { urls: [`${site.base}/files/guide-9.pdf`], folder: "From rows" });
    return { content: "Downloaded 2 files into From rows." };
  });
  saveSettings({
    scraping: { allowPrivateNetwork: true, minDelaySeconds: 1, respectRobots: true },
    ai: {
      providers: [{ id: "p", name: "Mock", baseUrl: llm.base, apiKey: "k", auth: "bearer", headers: [], timeoutSeconds: 30, enabled: true, models: [{ id: "m", contextWindow: 100_000, inputPrice: 0, outputPrice: 0, tools: true, json: true }] }],
      main: { providerId: "p", model: "m" }, fast: { providerId: "p", model: "m" }, dailyRequestLimit: 1000, agentApproval: "auto",
    },
  });
});
afterAll(async () => { await site.close(); await llm.close(); });

const run = (a: Record<string, unknown>) => TOOLS[String(a.__tool)]!.run(a, {} as never).then((r) => JSON.parse(String(r)) as Record<string, unknown>);
const ask = async (body: unknown) => {
  const res = await assistant.POST(new Request("http://localhost/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as never, {} as never);
  const { run: r } = await res.json() as { run: { id: string } };
  for (let i = 0; i < 200; i++) {
    const cur = getAgentRun(r.id)!;
    if (cur.status !== "running") return cur;
    await new Promise((x) => setTimeout(x, 100));
  }
  throw new Error("the run did not finish");
};

describe("AI on selected rows", () => {
  it("checks the links in the rows and downloads the files, following a page to its file", async () => {
    addNotification({ kind: "watcher", title: "Prices page changed", body: "2 lines changed" });
    const done = await ask({
      prompt: "Download the files these rows link to", page: "/tasks/abc",
      rows: { source: "Manuals run", columns: ["name", "link"], items: [{ name: "Manual", link: `${site.base}/files/manual.pdf` }, { name: "Item 9", link: `${site.base}/item/9` }] },
    });
    expect(done.status).toBe("done");
    const conv = seen.find((ms) => ms.filter((m) => m.role === "tool").length >= 4)!;
    const user = String(conv.find((m) => m.role === "user")?.content);
    expect(user).toContain("<rows>");
    expect(user).toContain("2 row(s) from Manuals run");
    expect(user).toContain("I am on /tasks/abc");
    expect(user).toContain("Prices page changed");
    expect(user).toMatch(/1 unread alert/);
    const checked = JSON.parse(String(conv.filter((m) => m.role === "tool")[0]!.content)) as { results: { kind: string }[] };
    expect(checked.results.map((r) => r.kind)).toEqual(["file", "web page"]);
    const files = listDownloads({ limit: 20 }).filter((d) => d.folder === "From rows").map((d) => d.url).sort();
    expect(files).toEqual([`${site.base}/files/guide-9.pdf`, `${site.base}/files/manual.pdf`]);
  });

  it("asks about an alert without rows", async () => {
    const done = await ask({ prompt: "Explain this", page: "/changes", focus: { kind: "watcher", title: "Prices page changed", body: "2 lines changed" } });
    expect(done.status).toBe("done");
    expect(seen.some((ms) => String(ms.find((m) => m.role === "user")?.content).includes("I am asking about this watcher"))).toBe(true);
  });
});

describe("full-control tools", () => {
  it("changes a watcher and keeps the rest", async () => {
    const w = createWatcher(watcherSchema.parse({ name: "Shop", url: `${site.base}/listing`, mode: "fast", target: { type: "page" }, condition: { type: "any_change" }, notify: { desktop: true, webhook: false, telegram: false }, intervalMinutes: 60 }));
    const r = await run({ __tool: "update_watcher", watcher: "Shop", interval_minutes: 15, condition: "contains", text: "Sale" });
    expect(r.updated).toBe(true);
    const after = getWatcher(w.id)!;
    expect(after.interval_minutes).toBe(15);
    expect(after.condition).toMatchObject({ type: "contains", text: "Sale" });
    expect(after.url).toBe(`${site.base}/listing`);
  });

  it("sets and clears a product's target price", async () => {
    const p = createProduct({ url: `${site.base}/dp/B0TESTASIN`, source: "amazon", externalId: "B0TESTASIN", targetPrice: null, intervalMinutes: 60 });
    await run({ __tool: "set_price_alert", product: p.url, target_price: 499 });
    expect(getProduct(p.id)!.target_price).toBe(499);
    await run({ __tool: "set_price_alert", product: p.id, target_price: 0, paused: true });
    expect(getProduct(p.id)!).toMatchObject({ target_price: null, enabled: false });
  });

  it("reads and clears the alert inbox", async () => {
    const r = await run({ __tool: "list_alerts", unread_only: true });
    expect((r.alerts as unknown[]).length).toBeGreaterThan(0);
    await run({ __tool: "mark_alerts_read", all: true });
    expect(unreadCount()).toBe(0);
    expect(listNotifications({ limit: 5 }).items.every((n) => n.read_at)).toBe(true);
  });

  it("marks the new tools that change things", () => {
    for (const t of ["update_watcher", "set_price_alert", "delete_deal_search", "mark_alerts_read"]) expect(TOOLS[t]!.changes).toBe(true);
    for (const t of ["check_links", "list_alerts", "list_deal_searches"]) expect(TOOLS[t]!.changes).toBe(false);
  });
});
