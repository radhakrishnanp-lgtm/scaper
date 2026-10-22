import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "./fixture-server";
import { startMockLlm } from "./mock-llm";

/** A local stand-in for Google's token endpoint and the Sheets API, holding sheets in memory. */
function startMockGoogle(publicKey: string) {
  const sheets = new Map<string, string[][]>([["Sheet1", []]]);
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      calls.push(`${req.method} ${decodeURIComponent(url.pathname)}`);
      if (url.pathname === "/token") {
        const jwt = new URLSearchParams(raw).get("assertion") ?? "";
        const [h, c, sig] = jwt.split(".");
        const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig ?? "", "base64url"));
        return ok ? send(200, { access_token: "tok-1", expires_in: 3600 }) : send(401, { error: "invalid_grant", error_description: "Bad signature" });
      }
      if (req.headers.authorization !== "Bearer tok-1") return send(401, { error: { message: "No token" } });
      const p = decodeURIComponent(url.pathname);
      if (req.method === "GET" && /^\/v4\/spreadsheets\/[\w-]+$/.test(p)) return send(200, { properties: { title: "Test sheet" }, sheets: [...sheets.keys()].map((t) => ({ properties: { title: t } })) });
      if (req.method === "POST" && p.endsWith(":batchUpdate") && !p.includes("/values")) {
        for (const r of (JSON.parse(raw) as { requests: { addSheet?: { properties: { title: string } } }[] }).requests) if (r.addSheet) sheets.set(r.addSheet.properties.title, []);
        return send(200, {});
      }
      const m = /^\/v4\/spreadsheets\/[\w-]+\/values\/'(.+?)'(?:!([A-Z]+)(\d+))?(:clear|:append)?$/.exec(p);
      if (m) {
        const tab = sheets.get(m[1]!) ?? [];
        if (req.method === "GET") return send(200, { values: tab });
        const body = JSON.parse(raw || "{}") as { values?: string[][] };
        if (m[4] === ":clear") { sheets.set(m[1]!, []); return send(200, {}); }
        if (m[4] === ":append") { tab.push(...body.values!); sheets.set(m[1]!, tab); return send(200, {}); }
        const row = Number(m[3] ?? 1) - 1;
        body.values!.forEach((v, i) => { tab[row + i] = v; });
        sheets.set(m[1]!, tab);
        return send(200, {});
      }
      if (req.method === "POST" && p.endsWith("/values:batchUpdate")) {
        for (const d of (JSON.parse(raw) as { data: { range: string; values: string[][] }[] }).data) {
          const [, tabName, row] = /^'(.+?)'!A(\d+)$/.exec(d.range)!;
          sheets.get(tabName!)![Number(row) - 1] = d.values[0]!;
        }
        return send(200, {});
      }
      send(404, { error: { message: `No route ${p}` } });
    });
  });
  return new Promise<{ base: string; sheets: typeof sheets; calls: string[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, sheets, calls, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** A webhook receiver whose replies the test controls. */
function startReceiver() {
  const got: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const replies: number[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => { got.push({ headers: req.headers, body: raw }); const s = replies.shift() ?? 200; res.writeHead(s); res.end(s < 300 ? "ok" : "nope"); });
  });
  return new Promise<{ url: string; got: typeof got; replies: number[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/hook`, got, replies, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

const keys = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const google = await startMockGoogle(keys.publicKey);

process.env.SCAPER_SCHEDULER = "off";
process.env.SCAPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scaper-enterprise-"));
process.env.SCAPER_GOOGLE_TOKEN_URL = `${google.base}/token`;
process.env.SCAPER_SHEETS_API_URL = `${google.base}/v4`;

const { openDatabase, setDatabaseForTests, db } = await import("@/server/db");
setDatabaseForTests(openDatabase(":memory:"));
const { saveSettings } = await import("@/server/repo/settings");
const { runTask } = await import("@/server/tasks/engine");
const { createRecipe, getRecipe, updateRecipe, listRuns } = await import("@/server/repo/scrapes");
const { listVersions, getVersion } = await import("@/server/repo/versions");
const { listIssues } = await import("@/server/repo/quality");
const { listProposals } = await import("@/server/repo/heal");
const { listJobs } = await import("@/server/repo/jobs");
const { waitForJob } = await import("@/server/jobs");
const { listNotifications } = await import("@/server/repo/notifications");
const { proposeFix, checkAgainstHistory, runHeal } = await import("@/server/ops/heal");
const { diagnoseRun, expectedRange } = await import("@/server/ops/diagnose");
const { taskHealth, fleetHealth, errorFingerprint } = await import("@/server/ops/health");
const { buildBriefing, briefingHtml } = await import("@/server/ops/briefing");
const { createWatcher, addSnapshot, listChanges, changeCounts, triageChanges, reviewAll, addIgnoreLines, listSnapshots, getWatcher } = await import("@/server/repo/watchers");
const { emitWebhook, processDueDeliveries, redeliver } = await import("@/server/integrations/webhooks");
const { listDeliveries, getDelivery } = await import("@/server/repo/deliveries");
const { syncDataset, spreadsheetId, testSheet } = await import("@/server/integrations/sheets");
const { handleMcp, mcpTools } = await import("@/server/mcp/server");
const { saveView, listViews, deleteView } = await import("@/server/repo/views");
const { runValidation, suggestRules, describeRule, toNumber, profileColumn } = await import("@/lib/validation");
const { extractSchema, taskSchema, validationRuleSchema, watcherSchema } = await import("@/lib/schemas");

let site: Awaited<ReturnType<typeof startFixtureServer>>;
let llm: Awaited<ReturnType<typeof startMockLlm>>;
let hook: Awaited<ReturnType<typeof startReceiver>>;

beforeAll(async () => {
  site = await startFixtureServer();
  hook = await startReceiver();
  llm = await startMockLlm((messages) => {
    const all = JSON.stringify(messages);
    // The repair: the shop renamed .card to .product and .price to .cost.
    if (all.includes("You write CSS selectors")) {
      return { content: JSON.stringify({ itemSelector: ".product", fields: [{ name: "title", selector: "a.title" }, { name: "link", selector: "a.title", attr: "href" }, { name: "price", selector: ".cost" }], note: "Cards are now .product." }) };
    }
    if (all.includes("data-quality checks")) {
      return { content: JSON.stringify({ rules: [{ column: "price", check: "pattern", arg: "^₹\\d+$", mostly: 100, severity: "fail", note: "Rupee price" }, { column: "nope", check: "not_empty" }, { column: "title", check: "pattern", arg: "([" }] }) };
    }
    return { content: "- Two changes on Rival shop.\n- One task needs attention." };
  });
  saveSettings({
    scraping: { allowPrivateNetwork: true, minDelaySeconds: 1, respectRobots: true },
    ai: { baseUrl: llm.base, apiKey: "k", model: "big", fastModel: "small", dailyRequestLimit: 200 },
  });
});
afterAll(async () => { await site.close(); await llm.close(); await hook.close(); await google.close(); });

const cards = extractSchema.parse({
  type: "selectors", itemSelector: ".card",
  fields: [{ name: "title", selector: "a.title" }, { name: "link", selector: "a.title", attr: "href" }, { name: "price", selector: ".price" }],
});
const ds = (rows: Record<string, string | number | null>[]) => ({ name: "Data", columns: Object.keys(rows[0] ?? {}), rows });

describe("data checks", () => {
  const good = ds(Array.from({ length: 20 }, (_, i) => ({ title: `Item ${i}`, link: `https://shop.example/i/${i}`, price: `₹${(i + 1) * 100}`, stock: i % 3 ? "In stock" : "Out of stock" })));

  it("reads prices the way people write them", () => {
    expect(toNumber("₹1,299")).toBe(1299);
    expect(toNumber("$ 12.50")).toBe(12.5);
    expect(toNumber("n/a")).toBeNull();
    expect(profileColumn(good, "price")).toMatchObject({ type: "number", fill: 100, min: 100, max: 2000 });
  });

  it("suggests checks from a good run that pass on it and catch a broken one", () => {
    const rules = suggestRules(good, { keyFields: ["link"] });
    const checks = rules.map((r) => `${r.column}:${r.check}`);
    expect(checks).toEqual(expect.arrayContaining(["*:row_count", "title:not_empty", "link:unique", "link:type", "price:type", "stock:one_of"]));
    for (const r of rules) expect(validationRuleSchema.safeParse(r).success).toBe(true);
    const ok = runValidation(good, rules);
    expect(ok.status).toBe("pass");
    expect(ok.score).toBe(100);

    // A redesign: half the prices are gone and the stock text changed.
    const broken = ds(good.rows.slice(0, 8).map((r, i) => ({ ...r, price: i % 2 ? null : r.price ?? null, stock: "Available" })));
    const bad = runValidation(broken, rules);
    expect(bad.status).toBe("fail");
    expect(bad.score!).toBeLessThan(80);
    const failed = bad.results.filter((r) => r.status !== "pass").map((r) => `${r.column}:${r.check}`);
    expect(failed).toEqual(expect.arrayContaining(["*:row_count", "stock:one_of"]));
    expect(bad.results.find((r) => r.check === "one_of")!.examples[0]).toEqual({ row: 0, value: "Available" });
  });

  it("honours 'mostly' and severity, and describes rules in words", () => {
    const rule = validationRuleSchema.parse({ id: "a", column: "price", check: "range", min: 150, max: null, mostly: 90, severity: "warn" });
    const r = runValidation(good, [rule]);
    expect(r.results[0]!.percent).toBe(95);
    expect(r.status).toBe("pass");
    expect(runValidation(good, [{ ...rule, mostly: 100 }]).status).toBe("warn");
    expect(describeRule(rule)).toBe("price is at least 150 in 90% of rows");
    expect(validationRuleSchema.safeParse({ id: "b", column: "x", check: "pattern", arg: "([" }).success).toBe(false);
  });
});

describe("failure reports", () => {
  const base = { mode: "fast" as const, extractType: "selectors" as const, rows: 0, okPages: 1, failedPages: 0, fetched: 1, error: null, hasSteps: false, aiFallbackPages: 0 };

  it("explains failures by cause, with a next step", () => {
    expect(diagnoseRun({ ...base, status: "error", okPages: 0, failedPages: 1, error: { code: "http", status: 404, message: "HTTP 404" } })).toMatchObject({ code: "not_found", area: "site", action: { kind: "edit" } });
    expect(diagnoseRun({ ...base, status: "blocked", okPages: 0, error: { code: "blocked", message: "Bot check." } })).toMatchObject({ code: "bot_check", action: { kind: "site" } });
    expect(diagnoseRun({ ...base, status: "ok", firstHtml: `<form action="/login"><input type="password"></form><p>Sign in</p>`, firstText: "Sign in to continue" })).toMatchObject({ code: "login_wall" });
    expect(diagnoseRun({ ...base, status: "ok", firstHtml: "<div>" + "<p>lots of text</p>".repeat(80) + "</div>", firstText: "lots of text ".repeat(80) })).toMatchObject({ code: "selectors_broken", area: "data", action: { kind: "heal" } });
    expect(diagnoseRun({ ...base, status: "ok", rows: 12, expected: { low: 40, high: 60, median: 50 } })).toMatchObject({ code: "fewer_rows", severity: "warning" });
    expect(diagnoseRun({ ...base, status: "ok", rows: 50 })).toBeNull();
  });

  it("learns the usual row count only from enough runs", () => {
    expect(expectedRange([100, 101, 99])).toBeNull();
    const r = expectedRange([100, 102, 98, 101, 99, 100])!;
    expect(r.median).toBe(100);
    expect(r.low).toBeLessThan(100);
    expect(r.low).toBeGreaterThan(30);
    expect(r.high).toBeGreaterThan(100);
  });

  it("groups the same error from different pages and days", () => {
    expect(errorFingerprint("Timed out after 30 s on https://a.example/p/1")).toBe(errorFingerprint("Timed out after 45 s on https://a.example/p/2"));
  });
});

describe("task operations", () => {
  it("versions every change to a task and restores old ones as a new version", () => {
    const t = createRecipe(taskSchema.parse({ name: "Versioned", url: `${site.base}/shop?page=1`, mode: "fast", extract: cards }));
    expect(t.version).toBe(1);
    const t2 = updateRecipe(t.id, { ...taskSchema.parse({ name: "Versioned", url: `${site.base}/shop?page=2`, mode: "fast", extract: cards }) }, { source: "edit", note: "page 2" })!;
    expect(t2.version).toBe(2);
    // Saving the same setup again doesn't add a version.
    updateRecipe(t.id, taskSchema.parse({ name: "Versioned", url: `${site.base}/shop?page=2`, mode: "fast", extract: cards }), { source: "edit" });
    expect(listVersions("task", t.id).map((v) => [v.version, v.source])).toEqual([[2, "edit"], [1, "create"]]);
    const v1 = getVersion("task", t.id, 1)!;
    const t3 = updateRecipe(t.id, taskSchema.parse(v1.data), { source: "restore", note: "Restored version 1" })!;
    expect(t3.version).toBe(3);
    expect(getRecipe(t.id)!.url).toBe(`${site.base}/shop?page=1`);
    expect(listVersions("task", t.id)[0]).toMatchObject({ version: 3, source: "restore" });
  });

  it("scores runs, opens and resolves data issues, and alerts on health once per problem", async () => {
    const task = createRecipe(taskSchema.parse({
      name: "Checked shop", url: `${site.base}/shop?page=1`, mode: "fast", extract: cards,
      options: {
        heal: { mode: "off" }, health: { failStreak: 2, anomaly: true },
        validation: { alert: "fail", rules: [{ id: "r1", column: "price", check: "pattern", arg: "^₹\\d+$" }, { id: "r2", column: "*", check: "row_count", min: 2 }] },
      },
    }));
    const run = (trigger: string, t = getRecipe(task.id)!) => runTask({ url: t.url, mode: t.mode, extract: t.extract, options: t.options, recipeId: t.id, taskName: t.name, trigger, version: t.version });

    const ok = await run("schedule");
    expect(ok.status).toBe("ok");
    expect(ok.score).toBe(100);
    expect(ok.validation).toMatchObject({ status: "pass", failed: 0 });

    // The site starts showing prices without the rupee sign: the check fails, an issue opens and you're told once.
    site.pages.set("/shop?page=1", { body: `<div class="card"><a class="title" href="/item/1">Item 1</a><span class="price">100</span></div><div class="card"><a class="title" href="/item/2">Item 2</a><span class="price">200</span></div>` });
    const bad = await run("schedule");
    expect(bad.validation).toMatchObject({ status: "fail", failed: 1, opened: 1 });
    expect(bad.diagnosis).toMatchObject({ code: "validation_failed", area: "data" });
    await run("schedule");
    const open = listIssues(task.id, "open");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ rule_id: "r1", runs: 2, severity: "fail" });
    expect(listNotifications({ limit: 50 }).items.filter((n) => n.title === "Checked shop: 1 new data issue")).toHaveLength(1);

    site.pages.set("/shop?page=1", { body: `<div class="card"><a class="title" href="/item/1">Item 1</a><span class="price">₹100</span></div><div class="card"><a class="title" href="/item/2">Item 2</a><span class="price">₹200</span></div>` });
    const fixed = await run("schedule");
    expect(fixed.validation).toMatchObject({ status: "pass", resolved: 1 });
    expect(listIssues(task.id, "open")).toHaveLength(0);
    expect(listNotifications({ limit: 50 }).items.some((n) => n.title === "Checked shop: data checks pass again")).toBe(true);

    // Two failed scheduled runs in a row → one "needs attention" alert, then one "healthy again".
    site.pages.set("/shop?page=1", { status: 500, body: "down" });
    await run("schedule");
    expect(getRecipe(task.id)!.health_alerted_at).toBeNull();
    const down = await run("schedule");
    expect(down.diagnosis).toMatchObject({ code: "server_error", area: "site" });
    expect(getRecipe(task.id)!.health_alerted_at).not.toBeNull();
    await run("schedule");
    expect(listNotifications({ limit: 50 }).items.filter((n) => n.title === "Checked shop needs attention")).toHaveLength(1);
    site.pages.set("/shop?page=1", { body: `<div class="card"><a class="title" href="/item/1">Item 1</a><span class="price">₹100</span></div><div class="card"><a class="title" href="/item/2">Item 2</a><span class="price">₹200</span></div>` });
    await run("schedule");
    expect(getRecipe(task.id)!.health_alerted_at).toBeNull();
    expect(listNotifications({ limit: 50 }).items.some((n) => n.title === "Checked shop is healthy again")).toBe(true);

    const h = taskHealth(getRecipe(task.id)!);
    expect(h.runs).toHaveLength(8);
    expect(h.failStreak).toBe(0);
    expect(h.successRate30d).toBe(62.5);
    expect(h.daily.at(-1)).toMatchObject({ ok: 5, failed: 3 });
    const fleet = fleetHealth();
    expect(fleet.tasks.find((t) => t.id === task.id)).toMatchObject({ runs: 8, lastStatus: "ok", openIssues: 0 });
    expect(fleet.errorGroups.find((g) => g.key === "server_error")).toMatchObject({ count: 3, affected: 1 });
  }, 90_000);

  it("repairs broken selectors with AI, checks them against the last good run, and applies them in auto mode", async () => {
    for (let n = 1; n <= 2; n++) {
      const items = [1, 2].map((k) => `<div class="card"><a class="title" href="/gadget/${(n - 1) * 2 + k}">Gadget ${(n - 1) * 2 + k}</a><span class="price">₹${k}00</span></div>`).join("");
      site.pages.set(`/gadgets?page=${n}`, { body: `<div class="list">${items}</div>` });
    }
    const task = createRecipe(taskSchema.parse({ name: "Gadgets", url: `${site.base}/gadgets?page=1`, mode: "fast", extract: cards, options: { heal: { mode: "auto" }, monitor: { keyFields: ["link"] } } }));
    const good = await runTask({ url: task.url, mode: "fast", extract: task.extract, options: task.options, recipeId: task.id, taskName: task.name, trigger: "manual" });
    expect(good.row_count).toBe(2);

    // The redesign: same items, new class names.
    site.pages.set("/gadgets?page=1", { body: `<div class="grid"><div class="product"><a class="title" href="/gadget/1">Gadget 1</a><b class="cost">₹100</b></div><div class="product"><a class="title" href="/gadget/2">Gadget 2</a><b class="cost">₹200</b></div></div>` });
    const broken = await runTask({ url: task.url, mode: "fast", extract: task.extract, options: { ...task.options, heal: { mode: "off" } }, recipeId: task.id, taskName: task.name, trigger: "manual" });
    expect(broken.row_count).toBe(0);
    expect(broken.diagnosis).toMatchObject({ code: "selectors_broken", action: { kind: "heal" } });

    const proposal = await proposeFix(getRecipe(task.id)!);
    const check = checkAgainstHistory(getRecipe(task.id)!, proposal);
    expect(check).toMatchObject({ passed: true, before: 0, after: 2, baselineRows: 2, keyOverlap: 1 });
    expect(check.fill.find((f) => f.column === "price")).toEqual({ column: "price", before: 100, after: 100 });

    await runHeal(task.id, broken.id, "The selectors matched nothing.");
    const healed = getRecipe(task.id)!;
    expect(healed.extract).toMatchObject({ itemSelector: ".product" });
    expect(listVersions("task", task.id)[0]).toMatchObject({ source: "auto_heal" });
    expect(listProposals(task.id)[0]).toMatchObject({ status: "applied", report: { passed: true } });
    // Applying it re-runs the task with the new selectors.
    const rerun = listJobs({ refId: task.id, limit: 5 }).items.find((j) => j.trigger === "repair")!;
    expect((await waitForJob(rerun.id, 30_000)).status).toBe("succeeded");
    expect(listRuns({ recipeId: task.id, limit: 1 }).items[0]).toMatchObject({ row_count: 2, status: "ok" });

    // A fix that finds unrelated items is kept for review instead of applied.
    site.pages.set("/gadgets?page=1", { body: `<div class="product"><a class="title" href="/other/9">Other</a><b class="cost">₹9</b></div><div class="product"><a class="title" href="/other/8">Other 2</a><b class="cost">₹8</b></div>` });
    const reject = checkAgainstHistory(healed, await proposeFix(healed));
    expect(reject.passed).toBe(false);
    expect(reject.reasons.join(" ")).toContain("Almost none of the items match");
  }, 90_000);
});

describe("change inbox and briefings", () => {
  it("triages changes, learns what to ignore without losing history, and writes a briefing", async () => {
    const w = createWatcher(watcherSchema.parse({ name: "Rival shop", url: "https://rival.example/", target: { type: "page" }, condition: { type: "any_change" }, notify: {}, intervalMinutes: 60, tags: ["competitors"] }));
    addSnapshot({ watcherId: w.id, content: "a", hash: "1", value: null, changed: false, triggered: false, diff: null });
    const c1id = addSnapshot({ watcherId: w.id, content: "b", hash: "2", value: null, changed: true, triggered: true, important: true, summary: "Price of the Pro plan went up to ₹999.", diff: { added: 1, removed: 1, patch: [{ op: "-", text: "Pro ₹799" }, { op: "+", text: "Pro ₹999" }] } });
    const c2id = addSnapshot({ watcherId: w.id, content: "c", hash: "3", value: null, changed: true, triggered: true, important: false, diff: { added: 1, removed: 1, patch: [{ op: "-", text: "12 people viewing" }, { op: "+", text: "15 people viewing" }] } });
    expect(changeCounts()).toMatchObject({ unreviewed: 2, important: 1, importantUnreviewed: 1 });
    expect(listChanges({ status: "important" }).items.map((c) => c.id)).toEqual([c1id]);
    expect(listChanges({ tag: "competitors" }).items).toHaveLength(2);

    triageChanges([c1id], { reviewed: true });
    expect(changeCounts().unreviewed).toBe(1);
    triageChanges([c2id], { feedback: "not_useful", important: false });
    const before = listSnapshots(w.id, { limit: 10 }).items.length;
    addIgnoreLines(w.id, ["people viewing"]);
    expect(getWatcher(w.id)!.ignore_lines).toEqual(["people viewing"]);
    expect(listSnapshots(w.id, { limit: 10 }).items).toHaveLength(before);
    expect(listChanges({ status: "not_useful" }).items.map((c) => c.id)).toEqual([c2id]);
    expect(reviewAll()).toBe(1);
    expect(changeCounts().unreviewed).toBe(0);

    const b = await buildBriefing({ days: 7, tags: ["competitors"], match: "any", ai: true });
    expect(b.stats).toMatchObject({ changes: 2, important: 1, watchers: 1 });
    expect(b.summary).toContain("Two changes on Rival shop");
    expect(b.markdown).toContain("**Rival shop** (2 changes): Price of the Pro plan went up to ₹999.");
    expect(b.quiet).toBe(false);
    const html = briefingHtml({ ...b, markdown: `${b.markdown}\n- <script>x</script>` });
    expect(html).toContain("<li>&lt;script&gt;x&lt;/script&gt;</li>");
    expect((await buildBriefing({ days: 7, tags: ["nobody"], match: "any", ai: false })).stats.changes).toBe(0);
  });
});

describe("integrations", () => {
  it("signs webhook deliveries, logs them, retries with backoff and redelivers", async () => {
    saveSettings({ integrations: { webhooks: [{ id: "n8n", name: "n8n", url: hook.url, secret: "s3cret", events: ["task.finished"], enabled: true }], webhookRetries: true } });
    hook.replies.push(500);
    const [r] = await emitWebhook("task.finished", { task: { id: "t1" } }, { refId: "t1" });
    expect(r).toMatchObject({ ok: false, retrying: true });
    const d = listDeliveries({ kind: "webhook" }).items[0]!;
    expect(d).toMatchObject({ status: "retrying", attempts: 1, response_code: 500, target_name: "n8n" });
    expect(Date.parse(d.next_attempt_at!) - Date.now()).toBeGreaterThan(20_000);

    const sent = hook.got[0]!;
    expect(sent.headers["x-scaper-event"]).toBe("scaper.task.finished");
    expect(sent.headers["x-scaper-delivery"]).toBe(d.id);
    expect(sent.headers["x-scaper-signature"]).toBe(createHmac("sha256", "s3cret").update(sent.body).digest("hex"));

    db().prepare("UPDATE deliveries SET next_attempt_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), d.id);
    expect(await processDueDeliveries()).toBe(1);
    expect(getDelivery(d.id)).toMatchObject({ status: "ok", attempts: 2, response_code: 200 });
    expect(hook.got[1]!.headers["x-scaper-delivery"]).toBe(d.id);

    hook.replies.push(502);
    expect((await redeliver(d.id))!.ok).toBe(false);
    expect(getDelivery(d.id)).toMatchObject({ attempts: 3 });

    saveSettings({ integrations: { webhookRetries: false } });
    hook.replies.push(500);
    await emitWebhook("task.finished", { task: { id: "t2" } });
    expect(listDeliveries({ kind: "webhook" }).items[0]).toMatchObject({ status: "failed", next_attempt_at: null });
    // Endpoints only get the events they chose.
    await expect(emitWebhook("watcher.change", {})).rejects.toThrow(/No webhook URL/);
  });

  it("syncs rows to Google Sheets: replace, then update by key and add new rows", async () => {
    const sa = JSON.stringify({ type: "service_account", client_email: "scaper@test.iam.gserviceaccount.com", private_key: keys.privateKey });
    const sheet = "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit#gid=0";
    expect(spreadsheetId(sheet)).toBe("1AbCdEfGhIjKlMnOp");
    expect(await testSheet(sheet, sa)).toEqual({ title: "Test sheet", sheets: ["Sheet1"] });

    const first = ds([{ link: "/a", name: "A", price: 100 }, { link: "/b", name: "B", price: 200 }]);
    expect(await syncDataset(first, { spreadsheet: sheet, sheet: "Prices", mode: "replace", keyFields: [] }, sa)).toMatchObject({ added: 2 });
    expect(google.sheets.get("Prices")).toEqual([["link", "name", "price"], ["/a", "A", 100], ["/b", "B", 200]]);

    const second = { name: "Data", columns: ["link", "name", "price", "stock"], rows: [{ link: "/b", name: "B", price: 180, stock: "yes" }, { link: "/c", name: "C", price: 300, stock: "no" }] };
    expect(await syncDataset(second, { spreadsheet: sheet, sheet: "Prices", mode: "upsert", keyFields: ["link"] }, sa)).toEqual({ added: 1, updated: 1, columns: 4 });
    expect(google.sheets.get("Prices")).toEqual([["link", "name", "price", "stock"], ["/a", "A", 100], ["/b", "B", 180, "yes"], ["/c", "C", 300, "no"]]);

    await expect(syncDataset(first, { spreadsheet: sheet, sheet: "Prices", mode: "append", keyFields: [] }, JSON.stringify({ client_email: "x@y", private_key: generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey }))).rejects.toThrow(/Google sign-in failed: Bad signature/);
    await expect(syncDataset(first, { spreadsheet: sheet, sheet: "Prices", mode: "append", keyFields: [] }, "{nope")).rejects.toThrow(/not valid JSON/);
  });

  it("serves Scaper's tools over MCP, read-only unless changes are allowed", async () => {
    const signal = new AbortController().signal;
    const init = await handleMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, signal);
    expect(init!.result).toMatchObject({ protocolVersion: "2025-03-26", serverInfo: { name: "scaper" }, capabilities: { tools: {} } });
    expect(await handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, signal)).toBeNull();

    saveSettings({ integrations: { mcpAllowWrite: false } });
    const list = (await handleMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, signal))!.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
    const names = list.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_tasks", "task_health", "change_inbox", "briefing"]));
    expect(names.some((n) => n.startsWith("browser_"))).toBe(false);
    expect(list.tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
    expect(mcpTools(true).length).toBeGreaterThan(names.length);

    const call = (await handleMcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_tasks", arguments: {} } }, signal))!.result as { content: { text: string }[]; isError: boolean };
    expect(call.isError).toBe(false);
    expect(call.content[0]!.text).toContain("Checked shop");
    const write = mcpTools(true).find((t) => t.changes)!;
    const denied = (await handleMcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: write.name, arguments: {} } }, signal))!.result as { isError: boolean; content: { text: string }[] };
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toContain("Allow changes");
    expect((await handleMcp({ jsonrpc: "2.0", id: 5, method: "nope" }, signal))!.error).toMatchObject({ code: -32601 });
  });

  it("saves table views per dataset", () => {
    const v = saveView({ scope: "task:x:Data", name: "Cheap", state: { filters: { price: { max: 500 } }, pinned: ["name"] } });
    expect(listViews("task:x:Data")).toHaveLength(1);
    saveView({ id: v.id, scope: "task:x:Data", name: "Cheap stuff", state: { filters: {} } });
    expect(listViews("task:x:Data").map((x) => x.name)).toEqual(["Cheap stuff"]);
    expect(listViews("task:y:Data")).toHaveLength(0);
    expect(deleteView(v.id)).toBe(true);
    expect(listViews("task:x:Data")).toHaveLength(0);
  });

  it("keeps runs linked to the setup version they used", () => {
    const t = listRuns({ limit: 50 }).items.find((r) => r.recipe_id && r.version);
    expect(t?.version).toBeGreaterThanOrEqual(1);
  });
});
