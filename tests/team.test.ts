import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "./fixture-server";

type Msg = { role: string; content: string | null; tool_calls?: { function: { name: string } }[] };
type Body = { messages: Msg[]; tools?: { function: { name: string } }[] };

let siteBase = "";
const call = (name: string, args: Record<string, unknown>) => ({ content: null, tool_calls: [{ id: `c-${name}-${Math.random().toString(36).slice(2, 7)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

/** The supervisor's and the helpers' model, scripted by who is talking and how many tool results came back. */
function script(body: Body): Record<string, unknown> & { __delay?: number } {
  const sys = body.messages[0]?.content ?? "";
  const toolsDone = body.messages.filter((m) => m.role === "tool").length;
  if (sys.includes("You are a helper agent")) {
    const role = /Your role: (.+)\./.exec(sys)?.[1] ?? "";
    if (role === "reader") {
      return [
        call("shared_memory_read", {}),
        call("read_page", { url: `${siteBase}/listing` }),
        call("shared_memory_write", { key: "listing:cheapest", value: "Cheapest headphone found on /listing" }),
        call("decide", { state: { item: "Headphones, ₹999, in stock" } }),
        { content: "| item | price |\n|---|---|\n| Headphones | ₹999 |\nSource: /listing" },
      ][Math.min(toolsDone, 4)]!;
    }
    if (role === "rogue") return toolsDone === 0 ? call("create_task", { name: "x", url: `${siteBase}/listing` }) : { content: "I could not create a task; that is for the supervisor." };
    if (role === "slow") return { ...call("shared_memory_read", {}), __delay: 1500 };
    return { content: "done" };
  }
  const prompt = body.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
  const first = body.messages.find((m) => m.role === "user")?.content ?? "";
  void prompt;
  if (first.includes("team job")) {
    return [
      call("spawn_agents", { agents: [
        { name: "reader", role: "reader", instructions: "Read the listing page and report the cheapest item with its price as a table. Share what you find.", task: "Find the cheapest item on the listing.", examples: "| item | price |", model: "fast",
          decision_questions: { in_stock: { type: "noul", instructions: "Is the item in state in stock?", criteria: { true: "It says in stock.", false: "It is out of stock or unclear." } } } },
        { name: "rogue", role: "rogue", instructions: "Try to save a task for the listing page so it runs every day.", task: "Save a task." },
      ] }),
      call("wait_for_agents", { timeout_seconds: 60 }),
      call("save_playbook", { name: "listing reader", kind: "price lookup", instructions: "Read the listing page and report the cheapest item with its price as a table. Share what you find.", examples: "| item | price |", notes: "Worked first time." }),
      { content: "The cheapest item is Headphones at ₹999." },
    ][Math.min(toolsDone, 3)]!;
  }
  if (first.includes("playbook job")) {
    return [
      call("spawn_agents", { agents: [{ name: "pb-reader", role: "reader", playbook: "listing reader", task: "Find the cheapest item on the listing." }] }),
      call("wait_for_agents", {}),
      call("rate_playbook", { name: "listing reader", worked: true, note: "Still good." }),
      { content: "Done with the playbook." },
    ][Math.min(toolsDone, 3)]!;
  }
  if (first.includes("limits job")) {
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `h${i}`, instructions: "Read pages and report what you find there.", task: "Read." }));
    return [
      call("spawn_agents", { agents: many }),
      call("spawn_agents", { agents: [{ name: "deleter", instructions: "Delete old tasks that nobody uses any more.", task: "Delete.", tools: ["delete_task"] }] }),
      { content: "Limits checked." },
    ][Math.min(toolsDone, 2)]!;
  }
  if (first.includes("slow job")) {
    return [
      call("spawn_agents", { agents: [{ name: "slowpoke", role: "slow", instructions: "Read the shared memory again and again, slowly.", task: "Keep reading." }] }),
      call("wait_for_agents", { timeout_seconds: 120 }),
      { content: "finished" },
    ][Math.min(toolsDone, 2)]!;
  }
  return { content: "ok" };
}

function startModels() {
  const chats: Body[] = [];
  const decisions: { questions: Record<string, unknown>; state: unknown }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.url === "/alpha/decisions") {
        const b = JSON.parse(raw) as { questions: Record<string, unknown>; state: unknown };
        decisions.push(b);
        return send({ id: "gen-dec-1", model: "openai/gpt-6-luna-decisions", answers: Object.fromEntries(Object.keys(b.questions).map((k) => [k, { type: "noul", noul: 0.9 }])), usage: { input_tokens: 100, output_tokens: 0, cost: 0.00001 } });
      }
      const body = JSON.parse(raw) as Body;
      chats.push(body);
      const { __delay, ...message } = script(body);
      setTimeout(() => send({ id: "x", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), __delay ?? 0);
    });
  });
  return new Promise<{ base: string; chats: Body[]; decisions: typeof decisions; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}/v1`, chats, decisions, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

process.env.SCAPER_SCHEDULER = "off";
process.env.SCAPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scaper-team-"));
const { openDatabase, setDatabaseForTests } = await import("@/server/db");
setDatabaseForTests(openDatabase(":memory:"));
const { saveSettings, getSettings } = await import("@/server/repo/settings");
const { startAgent, stopAgent } = await import("@/server/ai/agent");
const { getAgentRun } = await import("@/server/repo/agent");
const { listWorkers, readTeamMemory, getPlaybook, listPlaybooks } = await import("@/server/repo/team");
const { HELPER_TOOLS, helperPrompt } = await import("@/server/ai/team");

let site: Awaited<ReturnType<typeof startFixtureServer>>;
let models: Awaited<ReturnType<typeof startModels>>;

beforeAll(async () => {
  site = await startFixtureServer();
  siteBase = site.base;
  models = await startModels();
  saveSettings({
    scraping: { allowPrivateNetwork: true, minDelaySeconds: 1, respectRobots: true },
    ai: { baseUrl: models.base, apiKey: "k", model: "big", fastModel: "small", dailyRequestLimit: 1000, agentApproval: "ask" },
  });
  saveSettings({ ai: { decisions: { ...getSettings().ai.decisions, enabled: true, providerId: "default" } } });
});
afterAll(async () => { await site.close(); await models.close(); });

async function finished(id: string, ms = 30_000) {
  const until = Date.now() + ms;
  for (;;) {
    const r = getAgentRun(id)!;
    if (r.status !== "running") return r;
    if (Date.now() > until) throw new Error(`still running: ${JSON.stringify(r.steps.slice(-2))}`);
    await new Promise((res) => setTimeout(res, 50));
  }
}
const toolNames = (b: Body) => (b.tools ?? []).map((t) => t.function.name);

describe("agent team", () => {
  it("the supervisor starts helpers with its own instructions; they share memory, ask the decision model and report back", async () => {
    const run = await finished(startAgent({ prompt: "Do this team job: find the cheapest item", model: "main" }).id);
    expect(run.status).toBe("done");
    expect(run.answer).toContain("₹999");

    const supervisorCall = models.chats.find((b) => (b.messages[0]?.content ?? "").includes("Team work"))!;
    expect(toolNames(supervisorCall)).toEqual(expect.arrayContaining(["spawn_agents", "wait_for_agents", "find_playbooks", "save_playbook", "shared_memory_write"]));

    const workers = listWorkers(run.id);
    expect(workers.map((w) => [w.name, w.status])).toEqual([["reader", "done"], ["rogue", "done"]]);
    const reader = workers[0]!;
    expect(reader.result).toContain("| Headphones | ₹999 |");
    expect(reader.steps.filter((s) => s.type === "tool").map((s) => s.type === "tool" && s.name)).toEqual(["shared_memory_read", "read_page", "shared_memory_write", "decide"]);

    // The helper's system prompt: Scaper's rules first, then the supervisor's instructions, examples and questions.
    const helperCall = models.chats.find((b) => (b.messages[0]?.content ?? "").includes("Your role: reader."))!;
    const sys = helperCall.messages[0]!.content!;
    expect(sys.indexOf("Scaper's rules below always come before")).toBeLessThan(sys.indexOf("Read the listing page and report the cheapest item"));
    expect(sys).toContain("| item | price |");
    expect(sys).toContain("in_stock");
    // Helpers only get read-only tools.
    const offered = toolNames(helperCall);
    expect(offered).toEqual(expect.arrayContaining(["read_page", "decide", "shared_memory_read"]));
    expect(offered).not.toEqual(expect.arrayContaining(["create_task"]));
    expect(offered.some((n) => ["create_task", "delete_task", "notify_user", "spawn_agents", "remember"].includes(n))).toBe(false);

    // The helper used the supervisor's decision questions.
    expect(Object.keys(models.decisions.at(-1)!.questions)).toEqual(["in_stock"]);

    // The rogue helper could not change anything.
    const rogue = workers[1]!;
    const tried = rogue.steps.find((s) => s.type === "tool");
    expect(tried && tried.type === "tool" && tried.ok).toBe(false);
    expect(tried && tried.type === "tool" && tried.result).toMatch(/You do not have the tool create_task/);

    expect(readTeamMemory(run.id)).toEqual([expect.objectContaining({ author: "reader", key: "listing:cheapest" })]);
    expect(getPlaybook("listing reader")).toMatchObject({ version: 1, kind: "price lookup", source: "agent", uses: 0 });
  });

  it("playbooks are reused, counted and rated, and saving again makes a new version", async () => {
    const run = await finished(startAgent({ prompt: "Now a playbook job", model: "main" }).id);
    expect(run.status).toBe("done");
    const [w] = listWorkers(run.id);
    expect(w!.playbook_id).toBe(getPlaybook("listing reader")!.id);
    expect(w!.instructions).toContain("Read the listing page");
    expect(getPlaybook("listing reader")).toMatchObject({ uses: 1, wins: 1 });
    expect(getPlaybook("listing reader")!.notes).toMatch(/Still good/);
  });

  it("enforces the helper limit and keeps change tools away from helpers", async () => {
    const run = await finished(startAgent({ prompt: "limits job please", model: "main" }).id);
    const results = run.steps.filter((s) => s.type === "tool").map((s) => (s.type === "tool" ? s.result : ""));
    expect(results[0]).toMatch(/Error: .*(5|at most)/i);
    expect(results[1]).toMatch(/Helpers cannot use delete_task/);
    expect(listWorkers(run.id)).toHaveLength(0);
    expect(HELPER_TOOLS).not.toContain("delete_task");
    expect(helperPrompt({ role: "x", instructions: "y", examples: "", questions: null })).toMatch(/cannot save, change or delete/);
  });

  it("stopping the supervisor stops its helpers", async () => {
    const started = startAgent({ prompt: "slow job", model: "main" });
    const until = Date.now() + 10_000;
    while (!listWorkers(started.id).length && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    expect(listWorkers(started.id)[0]!.status).toBe("running");
    stopAgent(started.id);
    const until2 = Date.now() + 10_000;
    while (listWorkers(started.id)[0]!.status === "running" && Date.now() < until2) await new Promise((r) => setTimeout(r, 50));
    expect(listWorkers(started.id)[0]).toMatchObject({ status: "stopped", error: "Stopped by you." });
  });

  it("no helpers in private conversations or when the team is off", async () => {
    const before = models.chats.length;
    await finished(startAgent({ prompt: "hello", model: "main", private: true }).id);
    expect(toolNames(models.chats[before]!)).not.toContain("spawn_agents");

    saveSettings({ ai: { team: { ...getSettings().ai.team, enabled: false } } });
    const n = models.chats.length;
    await finished(startAgent({ prompt: "hello again", model: "main" }).id);
    expect(toolNames(models.chats[n]!)).not.toContain("spawn_agents");
    expect(models.chats[n]!.messages[0]!.content).not.toContain("Team work");
    saveSettings({ ai: { team: { ...getSettings().ai.team, enabled: true } } });
    expect(listPlaybooks().length).toBe(1);
  });
});
