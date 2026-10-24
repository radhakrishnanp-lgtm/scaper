import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockLlm } from "./mock-llm";

type Msg = { role: string; content: string | null };
const call = (name: string, args: Record<string, unknown>) => ({ content: null, tool_calls: [{ id: `c-${name}-${Math.random().toString(36).slice(2, 7)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const systems: string[] = [];
const toolLists: string[][] = [];

/** Each bot's job names the script it follows, so one mock model plays every bot. */
function script(messages: Msg[], body: Record<string, unknown>) {
  const sys = messages[0]?.content ?? "";
  systems.push(sys);
  toolLists.push(((body.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name));
  const tools = messages.filter((m) => m.role === "tool").length;
  const which = /SCRIPT:(\w+)/.exec(sys)?.[1] ?? "";
  const steps: Record<string, Record<string, unknown>[]> = {
    memory: [call("bot_memory_write", { key: "last_price", value: "₹1,999" }), call("notify_owner", { title: "Price dropped", body: "Now ₹1,999" }), { content: "Checked. The price is ₹1,999; I told you." }],
    readonly: [call("create_task", { name: "x", url: "https://example.com" }), { content: "I could not create it; I am read-only." }],
    nobots: [call("create_bot", { name: "Child", role: "child bot", task: "do things" }), { content: "Bots cannot make bots." }],
    ask: [call("pause_watcher", { watcher: "none" }), { content: "Done waiting." }],
    finish: [call("bot_finish", { reason: "The price reached ₹1,500" }), { content: "Target reached, pausing." }],
    spam: [call("notify_owner", { title: "1", body: "a" }), call("notify_owner", { title: "2", body: "b" }), call("notify_owner", { title: "3", body: "c" }), call("notify_owner", { title: "4", body: "d" }), { content: "Sent what I could." }],
    event: [{ content: "A task failed; here is why." }],
  };
  const list = steps[which];
  if (list) return list[Math.min(tools, list.length - 1)]!;
  return { content: "Hello from the bot." };
}

process.env.SCAPER_SCHEDULER = "off";
process.env.SCAPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scaper-bots-"));
const { openDatabase, setDatabaseForTests, db } = await import("@/server/db");
setDatabaseForTests(openDatabase(":memory:"));
const { saveSettings, getSettings } = await import("@/server/repo/settings");
const bots = await import("@/server/repo/bots");
const botAi = await import("@/server/ai/bots");
const { getAgentRun, listAgentRuns } = await import("@/server/repo/agent");
const { answerApproval, toolsFor } = await import("@/server/ai/agent");
const { listNotifications } = await import("@/server/repo/notifications");
const { deliver, flushHeldAlerts, routeChannels, sendWhatsapp } = await import("@/server/notify");
const { bus } = await import("@/server/bus");
const { readGuide, guideGaps } = await import("@/server/ai/knowledge");
const { HELPER_TOOLS } = await import("@/server/ai/team");
const botsRoute = await import("@/app/api/bots/route");
const botRoute = await import("@/app/api/bots/[id]/route");
const { botSchema, MAX_ACTIVE_BOTS } = await import("@/lib/schemas");

let llm: Awaited<ReturnType<typeof startMockLlm>>;

beforeAll(async () => {
  llm = await startMockLlm(script);
  saveSettings({
    ai: {
      providers: [{ id: "p", name: "Mock", baseUrl: llm.base, apiKey: "k", auth: "bearer", headers: [], timeoutSeconds: 30, enabled: true, models: [{ id: "big", contextWindow: 200_000, inputPrice: 0, outputPrice: 0, tools: true, json: true }] }],
      main: { providerId: "p", model: "big" }, fast: { providerId: "p", model: "big" }, dailyRequestLimit: 1000, agentApproval: "ask",
      learning: { guide: true, notes: true, selfReview: false, reviewMinSteps: 2 },
    },
  });
});
afterAll(async () => { botAi.stopBotEventsForTests(); await llm.close(); });

const base = (over: Record<string, unknown> = {}) => botSchema.parse({ name: `Bot ${Math.random().toString(36).slice(2, 7)}`, role: "Testing bot", task: "SCRIPT:none", ...over });

async function finished(id: string) {
  const until = Date.now() + 15_000;
  for (;;) {
    const r = getAgentRun(id)!;
    if (r.status !== "running") { await new Promise((res) => setTimeout(res, 30)); return getAgentRun(id)!; }
    if (Date.now() > until) throw new Error("still running");
    await new Promise((res) => setTimeout(res, 30));
  }
}
const req = (method: string, body?: unknown) => new Request("http://localhost/api/bots", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

describe("bots are saved with a schedule", () => {
  it("works out the next run for every kind of schedule", () => {
    const from = new Date(2026, 9, 24, 10, 0, 0); // Saturday 24 Oct 2026, 10:00
    expect(bots.nextRunAt({ type: "manual" }, from)).toBeNull();
    expect(bots.nextRunAt({ type: "interval", minutes: 30 }, from)).toBe(new Date(2026, 9, 24, 10, 30).toISOString());
    expect(bots.nextRunAt({ type: "daily", time: "09:00", days: [] }, from)).toBe(new Date(2026, 9, 25, 9, 0).toISOString());
    expect(bots.nextRunAt({ type: "daily", time: "18:30", days: [] }, from)).toBe(new Date(2026, 9, 24, 18, 30).toISOString());
    // Weekdays only: Saturday → Monday.
    expect(bots.nextRunAt({ type: "daily", time: "09:00", days: [1, 2, 3, 4, 5] }, from)).toBe(new Date(2026, 9, 26, 9, 0).toISOString());
    expect(bots.describeSchedule({ type: "interval", minutes: 360 })).toBe("Every 6 hours");
    expect(bots.describeSchedule({ type: "daily", time: "09:00", days: [1, 5] })).toBe("At 09:00 on Mon, Fri");
  });

  it("refuses too-frequent schedules, duplicate names and more than the active limit", async () => {
    const bad = await botsRoute.POST(req("POST", { name: "Fast", role: "too fast", task: "check often", schedule: { type: "interval", minutes: 1 } }) as never, undefined as never);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toContain("At least every 5 minutes");

    const b = bots.createBot(base({ name: "Unique" }));
    expect(() => bots.createBot(base({ name: "unique" }))).toThrow(/already have a bot/);
    for (let i = bots.listBots().filter((x) => x.enabled).length; i < MAX_ACTIVE_BOTS; i++) bots.createBot(base());
    expect(() => bots.createBot(base())).toThrow(/up to 20 active bots/);
    bots.updateBot(b.id, { enabled: false });
    expect(bots.createBot(base({ name: "Fits again" })).enabled).toBe(true);
    for (const x of bots.listBots()) bots.deleteBot(x.id);
  });

  it("saving one field over the API keeps the others", async () => {
    const b = bots.createBot(base({ name: "Keeper", instructions: "Be brief", schedule: { type: "interval", minutes: 60 }, permission: "read" }));
    const res = await botRoute.PUT(new Request(`http://localhost/api/bots/${b.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "New role" }) }) as never, { params: Promise.resolve({ id: b.id }) } as never);
    expect(res.status).toBe(200);
    expect(bots.getBot(b.id)).toMatchObject({ role: "New role", instructions: "Be brief", permission: "read", schedule: { type: "interval", minutes: 60 } });
    bots.deleteBot(b.id);
  });
});

describe("a bot run", () => {
  it("runs on schedule, keeps its own memory, messages you and remembers the run", async () => {
    const b = bots.createBot(base({ name: "Saver", emoji: "🏷️", task: "SCRIPT:memory check the price", schedule: { type: "interval", minutes: 60 } }));
    db().prepare("UPDATE bots SET next_run_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), b.id);
    expect(botAi.runDueBots()).toBe(1);
    const run = await finished(bots.getBot(b.id)!.last_run_id!);
    expect(run).toMatchObject({ status: "done", bot_id: b.id, trigger: "schedule" });
    expect(run.steps.filter((s) => s.type === "tool").map((s) => s.type === "tool" && [s.name, s.ok])).toEqual([["bot_memory_write", true], ["notify_owner", true]]);

    const after = bots.getBot(b.id)!;
    expect(after).toMatchObject({ last_status: "done", run_count: 1, running: false });
    expect(Date.parse(after.next_run_at!)).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(bots.listBotMemory(b.id, "fact")).toMatchObject([{ key: "last_price", value: "₹1,999" }]);
    expect(bots.listBotMemory(b.id, "run")[0]!.value).toContain("The price is ₹1,999");
    expect(listNotifications({ kind: "bot" }).items[0]).toMatchObject({ title: "🏷️ Saver: Price dropped", body: "Now ₹1,999" });
    // Bot runs live on the bot's page, not in the agent chat list.
    expect(listAgentRuns().some((r) => r.id === run.id)).toBe(false);

    // The next run starts with what it remembered.
    const next = await finished(botAi.runBot(b.id, { trigger: "manual" }).id);
    expect(next.status).toBe("done");
    const sys = systems.findLast((s) => s.includes("Saver"))!;
    expect(sys).toContain("- last_price: ₹1,999");
    expect(sys).toContain("Your recent runs, newest first:");
    expect(sys).toContain('You are running as the bot "🏷️ Saver"');
  });

  it("gets only the tools its permission allows, and can never manage bots", async () => {
    expect(toolsFor({ bot: { permission: "read" }, team: false }).names.has("create_task")).toBe(false);
    expect(toolsFor({ bot: { permission: "ask" }, team: false }).names.has("create_task")).toBe(true);
    expect(toolsFor({ bot: { permission: "auto" }, team: false }).names.has("create_bot")).toBe(false);
    expect(toolsFor({ bot: null, team: false }).names.has("bot_memory_write")).toBe(false);
    expect(toolsFor({ bot: null, team: false }).names.has("create_bot")).toBe(true);
    expect(HELPER_TOOLS).not.toContain("notify_owner");
    const { mcpTools } = await import("@/server/mcp/server");
    expect(mcpTools(true).map((t) => t.name)).not.toContain("bot_memory_write");

    const ro = bots.createBot(base({ name: "Reader", task: "SCRIPT:readonly", permission: "read" }));
    const run = await finished(botAi.runBot(ro.id, { trigger: "manual" }).id);
    expect(run.steps[0]).toMatchObject({ type: "tool", name: "create_task", ok: false });
    expect((run.steps[0] as { result: string }).result).toContain("read-only");
    expect(toolLists.at(-1)).not.toContain("create_task");

    const nb = bots.createBot(base({ name: "Maker", task: "SCRIPT:nobots", permission: "auto" }));
    const made = await finished(botAi.runBot(nb.id, { trigger: "manual" }).id);
    expect(made.steps[0]).toMatchObject({ name: "create_bot", ok: false });
    expect(bots.getBot("Child")).toBeNull();
  });

  it("asks you on its channels when a change needs your OK", async () => {
    const b = bots.createBot(base({ name: "Asker", emoji: "🙋", task: "SCRIPT:ask", permission: "ask" }));
    const run = botAi.runBot(b.id, { trigger: "manual" });
    const until = Date.now() + 10_000;
    while (!getAgentRun(run.id)!.pending && Date.now() < until) await new Promise((r) => setTimeout(r, 30));
    expect(getAgentRun(run.id)!.pending?.tool).toBe("pause_watcher");
    await new Promise((r) => setTimeout(r, 100));
    const asked = listNotifications({ kind: "bot" }).items.find((n) => n.title === "🙋 Asker: needs your OK")!;
    expect(asked.url).toBe(`http://localhost:3000/bots/${b.id}`);
    expect(answerApproval(run.id, "deny")).toBe(true);
    const done = await finished(run.id);
    expect(done.steps[0]).toMatchObject({ approval: "declined" });
  });

  it("pauses itself when its end condition is met", async () => {
    const b = bots.createBot(base({ name: "Finisher", task: "SCRIPT:finish", stopWhen: "the price is below ₹1,600", schedule: { type: "interval", minutes: 30 } }));
    await finished(botAi.runBot(b.id, { trigger: "manual" }).id);
    expect(bots.getBot(b.id)).toMatchObject({ enabled: false, next_run_at: null, finished_reason: "The price reached ₹1,500" });
    expect(() => botAi.runBot(b.id, { trigger: "schedule" })).toThrow(/paused/);
  });

  it("sends at most 3 messages per run", async () => {
    const b = bots.createBot(base({ name: "Spammer", task: "SCRIPT:spam" }));
    const run = await finished(botAi.runBot(b.id, { trigger: "manual" }).id);
    expect(run.steps.filter((s) => s.type === "tool").map((s) => s.type === "tool" && s.ok)).toEqual([true, true, true, false]);
  });

  it("does not run in private mode", () => {
    const b = bots.createBot(base({ name: "Private" }));
    saveSettings({ data: { ...getSettings().data, privateMode: true } });
    expect(() => botAi.runBot(b.id, { trigger: "manual" })).toThrow(/Private mode/);
    saveSettings({ data: { ...getSettings().data, privateMode: false } });
  });
});

describe("events wake bots", () => {
  it("a failed task wakes the bot that listens for it, once per cooldown; a bot's own alerts wake nobody", async () => {
    botAi.startBotEvents();
    const b = bots.createBot(base({ name: "Babysitter", task: "SCRIPT:event", triggers: [{ event: "task.failed", refId: "task-1" }], cooldownMinutes: 10 }));
    bus.emit({ type: "task_run", id: "r1", recipeId: "task-2", name: "Other", status: "error", rows: 0, trigger: "schedule" });
    expect(bots.getBot(b.id)!.run_count).toBe(0);
    bus.emit({ type: "task_run", id: "r2", recipeId: "task-1", name: "Shop", status: "error", rows: 0, trigger: "schedule" });
    const first = bots.getBot(b.id)!;
    expect(first.run_count).toBe(1);
    const run = await finished(first.last_run_id!);
    expect(run.trigger).toBe("event:task.failed");
    expect(run.prompt).toContain("<event>\nTitle: Shop failed");
    bus.emit({ type: "task_run", id: "r3", recipeId: "task-1", name: "Shop", status: "error", rows: 0, trigger: "schedule" });
    expect(bots.getBot(b.id)!.run_count).toBe(1);

    const watcher = bots.createBot(base({ name: "Change bot", task: "SCRIPT:event", triggers: [{ event: "watcher.change", refId: null }] }));
    bus.emit({ type: "notification", id: "n1", title: "x", body: "y", url: null, desktop: false, kind: "watcher", refId: "w1", botId: watcher.id });
    expect(bots.getBot(watcher.id)!.run_count).toBe(0);
    expect(botAi.toBotEvent({ type: "notification", id: "n2", title: "Page", body: "changed", url: null, desktop: false, kind: "watcher", refId: "w1" })).toMatchObject({ event: "watcher.change", refId: "w1" });
  });
});

describe("alert routing and WhatsApp", () => {
  it("adds the channels set for each kind of alert, and 'all' means every channel that is set up", () => {
    saveSettings({ notifications: { ...getSettings().notifications, telegramBotToken: "1:abc", telegramChatId: "42", ntfyUrl: "https://ntfy.sh/x", routes: { ...getSettings().notifications.routes, taskDone: ["email"], dealFound: ["all"] } } });
    expect(routeChannels("taskDone", { desktop: false })).toEqual({ desktop: false, email: true });
    expect(routeChannels("dealFound", { desktop: true })).toMatchObject({ desktop: true, telegram: true, ntfy: true });
    expect(routeChannels("dealFound", { desktop: true }).email).toBeUndefined();
    expect(routeChannels("watcherChange", { slack: true })).toEqual({ slack: true });
    expect(routeChannels(undefined, { slack: true })).toEqual({ slack: true });
  });

  it("explains what WhatsApp needs before sending", async () => {
    await expect(sendWhatsapp({ kind: "system", title: "t", body: "b" })).rejects.toThrow(/WhatsApp Cloud API token, phone number ID/);
    saveSettings({ notifications: { ...getSettings().notifications, whatsappProvider: "callmebot" } });
    await expect(sendWhatsapp({ kind: "system", title: "t", body: "b" })).rejects.toThrow(/CallMeBot API key/);
  });

  it("holds external alerts during quiet hours and sends them when quiet hours end", async () => {
    const http = await import("node:http");
    const got: string[] = [];
    const server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got.push(`${String(req.headers.title)}|${b}`); res.end("ok"); }); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const n = getSettings().notifications;
    saveSettings({
      scraping: { ...getSettings().scraping, allowPrivateNetwork: true },
      notifications: { ...n, ntfyUrl: `http://127.0.0.1:${port}/topic`, quietHoursEnabled: true, quietStart: hhmm(new Date(Date.now() - 3600_000)), quietEnd: hhmm(new Date(Date.now() + 3600_000)) },
    });
    await deliver({ kind: "price", title: "Price drop", body: "Now ₹999" }, { ntfy: true });
    expect(got).toEqual([]);
    expect(await flushHeldAlerts()).toBe(0);
    saveSettings({ notifications: { ...getSettings().notifications, quietHoursEnabled: false } });
    expect(await flushHeldAlerts()).toBe(1);
    expect(got[0]).toContain("Price drop (held during quiet hours)");
    expect(await flushHeldAlerts()).toBe(0);

    // More than five become one summary.
    saveSettings({ notifications: { ...getSettings().notifications, quietHoursEnabled: true } });
    for (let i = 1; i <= 7; i++) await deliver({ kind: "watcher", title: `Change ${i}`, body: "x" }, { ntfy: true });
    saveSettings({ notifications: { ...getSettings().notifications, quietHoursEnabled: false } });
    expect(await flushHeldAlerts()).toBe(7);
    expect(got).toHaveLength(2);
    expect(got[1]).toContain("7 alerts during quiet hours");
    expect(got[1]).toContain("Change 7");
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("the guide knows about bots and routes", () => {
    expect(guideGaps()).toEqual({ pages: [], tools: [], topics: [] });
    expect(readGuide({ topic: "bots" })).toContain("bot_memory_write");
    expect(readGuide({ topic: "alerts" })).toContain("WhatsApp");
    expect(readGuide({ topic: "tools" })).toContain("- notify_owner");
  });
});
