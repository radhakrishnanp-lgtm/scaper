import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** A provider with a switchable personality: a good key, a refused key, or no model list at all. */
function startProvider() {
  const ctl = { key: "sk-good", models: true as boolean };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.headers.authorization !== `Bearer ${ctl.key}`) return json(401, { error: { message: "Incorrect API key" } });
      if (req.url === "/v1/models") {
        if (!ctl.models) return json(404, { error: { message: "not found" } });
        return json(200, { data: [{ id: "text-embedding-3-small" }, { id: "big-1m", context_length: 1_000_000 }, { id: "big-mini" }] });
      }
      const body = JSON.parse(raw) as { tools?: unknown[]; response_format?: unknown };
      const message = body.tools ? { content: null, tool_calls: [{ id: "t", type: "function", function: { name: "get_time", arguments: "{}" } }] } : body.response_format ? { content: '{"ok": true}' } : { content: "ready" };
      json(200, { id: "x", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    });
  });
  return new Promise<{ base: string; ctl: typeof ctl; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}/v1`, ctl, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

process.env.SCAPER_SCHEDULER = "off";
process.env.SCAPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scaper-setup-"));
const { openDatabase, setDatabaseForTests } = await import("@/server/db");
setDatabaseForTests(openDatabase(":memory:"));
const { saveSettings, getSettings } = await import("@/server/repo/settings");
const { checkConnection, contextBudget } = await import("@/server/ai/client");
const setup = await import("@/server/fetcher/browser-setup");
const { executablePath } = await import("@/server/fetcher/browser");
const settingsRoute = await import("@/app/api/settings/route");

let prov: Awaited<ReturnType<typeof startProvider>>;
const provider = (apiKey: string, models: { id: string; contextWindow?: number | null }[] = []) => ({
  id: "p", name: "Test AI", baseUrl: prov.base, apiKey, auth: "bearer" as const, headers: [], timeoutSeconds: 30, enabled: true,
  models: models.map((m) => ({ id: m.id, contextWindow: m.contextWindow ?? null, inputPrice: 0, outputPrice: 0, tools: null, json: null })),
});

beforeAll(async () => {
  prov = await startProvider();
  saveSettings({ scraping: { allowPrivateNetwork: true }, ai: { dailyRequestLimit: 1000 } });
});
afterAll(async () => { await prov.close(); setup.setInstallCommandForTests(null); });

describe("Test connection before saving a provider", () => {
  it("a good key lists models, picks a chat model and checks it answers and calls tools", async () => {
    const r = await checkConnection(provider("sk-good"));
    expect(r.ok).toBe(true);
    expect(r.model).toBe("big-mini");
    expect(r.models.find((m) => m.id === "big-1m")?.contextWindow).toBe(1_000_000);
    expect(r.steps.map((s) => [s.label, s.ok])).toEqual([["Model list", true], ["Model answer", true], ["Tool calling", true]]);
    expect(r.tools).toBe(true);
  });

  it("a wrong key stops at the first step with a plain reason", async () => {
    const r = await checkConnection(provider("sk-typo"));
    expect(r.ok).toBe(false);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.detail).toMatch(/refused the API key \(401\)/);
  });

  it("a server without a model list still passes when the model answers", async () => {
    prov.ctl.models = false;
    const r = await checkConnection(provider("sk-good", [{ id: "local-model" }]));
    prov.ctl.models = true;
    expect(r.ok).toBe(true);
    expect(r.steps[0]).toMatchObject({ label: "Model list", ok: false });
    expect(r.steps[1]).toMatchObject({ label: "Model answer", ok: true });
  });

  it("nothing is saved by a check", async () => {
    await checkConnection(provider("sk-good"));
    expect(getSettings().ai.providers).toHaveLength(0);
  });
});

describe("1M-token models", () => {
  it("send up to 60% of a 1M window as page text, and 1M is allowed as the default context", () => {
    saveSettings({ ai: { providers: [provider("sk-good", [{ id: "big-1m", contextWindow: 1_000_000 }, { id: "small", contextWindow: 128_000 }])], main: { providerId: "p", model: "big-1m" }, fast: { providerId: "p", model: "small" }, maxTokens: 4000, contextTokens: 1_000_000 } });
    expect(contextBudget("main")).toBe(596_000);
    expect(contextBudget("fast")).toBe(76_800 - 4000);
    expect(getSettings().ai.contextTokens).toBe(1_000_000);
  });
});

describe("settings API", () => {
  const put = (body: unknown) => settingsRoute.PUT(new Request("http://127.0.0.1:3000/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as never, undefined as never);

  it("saving one field keeps every other field (the provider is not wiped)", async () => {
    const res = await put({ ai: { team: { ...getSettings().ai.team, maxAgents: 3 } } });
    expect(res.status).toBe(200);
    expect(getSettings().ai.providers).toHaveLength(1);
    expect(getSettings().ai.main.model).toBe("big-1m");
    expect(getSettings().ai.team.maxAgents).toBe(3);
  });

  it("accepts a SOCKS5 proxy", async () => {
    expect((await put({ scraping: { proxyUrl: "socks5://127.0.0.1:1080" } })).status).toBe(200);
    expect(getSettings().scraping.proxyUrl).toBe("socks5://127.0.0.1:1080");
    await put({ scraping: { proxyUrl: "" } });
  });

  it("only accepts a real browser file as the browser", async () => {
    expect((await put({ scraping: { browserPath: "/etc/passwd" } })).status).toBe(400);
    expect((await put({ scraping: { browserPath: "/bin/sh" } })).status).toBe(400);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scaper-chrome-"));
    const fake = path.join(dir, process.platform === "win32" ? "chrome.exe" : "chrome");
    fs.writeFileSync(fake, "");
    expect((await put({ scraping: { browserPath: fake } })).status).toBe(200);
    const prev = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
    expect(setup.browserStatus()).toMatchObject(prev ? { source: "env" } : { source: "chosen", path: fake, ready: true });
    if (!prev) expect(executablePath()).toBe(fake);
    fs.rmSync(dir, { recursive: true });
    expect(setup.browserStatus().chosenMissing).toBe(true);
    await put({ scraping: { browserPath: "" } });
  });
});

describe("installing the scraping browser from the app", () => {
  const waitFor = async () => {
    const until = Date.now() + 10_000;
    while (setup.browserStatus().install.state === "running" && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    return setup.browserStatus().install;
  };

  it("runs the installer once, follows its progress and reports the result", async () => {
    setup.setInstallCommandForTests(() => ({ cmd: process.execPath, args: ["-e", "console.log('Downloading Chromium'); for (const p of [10, 55, 100]) console.log(`|■■■| ${p}% of 150 MiB`)"] }));
    const first = setup.startBrowserInstall();
    expect(first.install.state).toBe("running");
    expect(setup.startBrowserInstall().install.state).toBe("running"); // a second click does not start another
    const done = await waitFor();
    expect(done.log[0]).toBe("Downloading Chromium");
    expect(done.log.filter((l) => l.includes("%"))).toHaveLength(1); // progress lines collapse into one
    expect(done.percent).toBe(100);
    expect(done.state).toBe(setup.browserStatus().bundled.installed ? "done" : "error");
  });

  it("explains a failed install", async () => {
    setup.setInstallCommandForTests(() => ({ cmd: process.execPath, args: ["-e", "console.error('Error: getaddrinfo ENOTFOUND cdn.playwright.dev'); process.exit(1)"] }));
    setup.startBrowserInstall();
    const done = await waitFor();
    expect(done.state).toBe("error");
    expect(done.error).toMatch(/stopped with code 1. Error: getaddrinfo ENOTFOUND.*network is offline/);
  });

  it("finds browsers on this computer only by known names", () => {
    expect(setup.isBrowserFile("relative/chrome")).toBe(false);
    for (const b of setup.findSystemBrowsers()) expect(setup.isBrowserFile(b.path)).toBe(true);
  });
});
