import "server-only";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, firefox } from "playwright";
import { env } from "../env";
import { log } from "../log";
import { getSettings } from "../repo/settings";
import { closeBrowser, executablePath } from "./browser";

/**
 * Setting up Browser mode from the app: install the Chromium build Playwright expects with one click,
 * or use a Chrome, Edge, Brave or Chromium that is already on this computer.
 */

type InstallState = { which?: "chromium" | "firefox"; state: "idle" | "running" | "done" | "error"; startedAt: string | null; finishedAt: string | null; log: string[]; error: string | null; percent: number | null };
const g = globalThis as unknown as { __scaperBrowserInstall?: InstallState; __scaperInstallCommand?: (which: "chromium" | "firefox") => { cmd: string; args: string[] } };
const install: InstallState = (g.__scaperBrowserInstall ??= { state: "idle", startedAt: null, finishedAt: null, log: [], error: null, percent: null });

/** Names a browser file must have before Scaper will run it. */
const BROWSER_FILE = /^(chrome|chromium|chromium-browser|google-chrome(-stable)?|msedge|microsoft-edge(-stable)?|brave|brave-browser|Google Chrome|Microsoft Edge|Brave Browser|Chromium)(\.exe)?$/i;

export function isBrowserFile(p: string) {
  return path.isAbsolute(p) && BROWSER_FILE.test(path.basename(p)) && fs.existsSync(p) && fs.statSync(p).isFile();
}

function candidates(): { name: string; path: string }[] {
  if (process.platform === "win32") {
    const roots = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    return roots.flatMap((r) => [
      { name: "Google Chrome", path: path.join(r, "Google", "Chrome", "Application", "chrome.exe") },
      { name: "Microsoft Edge", path: path.join(r, "Microsoft", "Edge", "Application", "msedge.exe") },
      { name: "Brave", path: path.join(r, "BraveSoftware", "Brave-Browser", "Application", "brave.exe") },
    ]);
  }
  if (process.platform === "darwin") {
    const apps = ["/Applications", path.join(os.homedir(), "Applications")];
    return apps.flatMap((a) => [
      { name: "Google Chrome", path: path.join(a, "Google Chrome.app", "Contents", "MacOS", "Google Chrome") },
      { name: "Microsoft Edge", path: path.join(a, "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge") },
      { name: "Brave", path: path.join(a, "Brave Browser.app", "Contents", "MacOS", "Brave Browser") },
      { name: "Chromium", path: path.join(a, "Chromium.app", "Contents", "MacOS", "Chromium") },
    ]);
  }
  return [
    { name: "Google Chrome", path: "/usr/bin/google-chrome" }, { name: "Google Chrome", path: "/usr/bin/google-chrome-stable" },
    { name: "Chromium", path: "/usr/bin/chromium" }, { name: "Chromium", path: "/usr/bin/chromium-browser" }, { name: "Chromium", path: "/snap/bin/chromium" },
    { name: "Microsoft Edge", path: "/usr/bin/microsoft-edge" }, { name: "Brave", path: "/usr/bin/brave-browser" },
  ];
}

/** Browsers already on this computer that Scaper can use instead of downloading one. */
export function findSystemBrowsers() {
  const seen = new Set<string>();
  return candidates().filter((c) => {
    if (seen.has(c.path)) return false;
    seen.add(c.path);
    try { return isBrowserFile(c.path); } catch { return false; }
  });
}

function bundledPath(which: "chromium" | "firefox" = "chromium") {
  try { return (which === "firefox" ? firefox : chromium).executablePath(); } catch { return ""; }
}

export function browserStatus() {
  const bundled = bundledPath();
  const bundledInstalled = Boolean(bundled && fs.existsSync(/* turbopackIgnore: true */ bundled));
  const chosen = getSettings().scraping.browserPath;
  const active = executablePath();
  const source: "env" | "chosen" | "bundled" = env.PLAYWRIGHT_EXECUTABLE_PATH ? "env" : chosen && active === chosen ? "chosen" : "bundled";
  const ready = source === "bundled" ? bundledInstalled : Boolean(active && fs.existsSync(active));
  return {
    ready,
    source,
    path: source === "bundled" ? bundled : active ?? "",
    chosen,
    chosenMissing: Boolean(chosen && !fs.existsSync(chosen)),
    bundled: { installed: bundledInstalled, path: bundled },
    firefox: { installed: Boolean(bundledPath("firefox") && fs.existsSync(/* turbopackIgnore: true */ bundledPath("firefox"))), path: bundledPath("firefox") },
    system: findSystemBrowsers(),
    install: { ...install, log: install.log.slice(-12) },
  };
}

/** Playwright's own installer for the Chromium build this version expects. No shell, no user input in the command. */
function installCommand(which: "chromium" | "firefox") {
  if (g.__scaperInstallCommand) return g.__scaperInstallCommand(which);
  const cli = path.join(/* turbopackIgnore: true */ process.cwd(), "node_modules", "playwright", "cli.js");
  return { cmd: process.execPath, args: [cli, "install", which] };
}

export function setInstallCommandForTests(fn: ((which: "chromium" | "firefox") => { cmd: string; args: string[] }) | null) {
  g.__scaperInstallCommand = fn ?? undefined;
  Object.assign(install, { state: "idle", startedAt: null, finishedAt: null, log: [], error: null, percent: null });
}

/** Installs Playwright's Chromium (for scraping and the Browser page) or its Firefox (for the Browser page). */
export function startBrowserInstall(which: "chromium" | "firefox" = "chromium") {
  if (install.state === "running") return browserStatus();
  const { cmd, args } = installCommand(which);
  Object.assign(install, { which, state: "running", startedAt: new Date().toISOString(), finishedAt: null, log: [], error: null, percent: 0 });
  log.info("browser.install_started", {});
  // PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD only stops the npm postinstall step; an explicit install should still run.
  const child = spawn(cmd, args, { cwd: /* turbopackIgnore: true */ process.cwd(), env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const onData = (chunk: Buffer) => {
    for (const raw of chunk.toString("utf8").split(/\r|\n/)) {
      // Drop colour codes and stack frames; keep what a person can act on.
      const line = raw.replace(/\u001b\[[0-9;]*m/g, "").trim();
      if (!line || /^at /.test(line)) continue;
      const pct = /(\d{1,3})%/.exec(line);
      if (pct) install.percent = Math.min(100, Number(pct[1]));
      // Progress bars print many times a second; keep one line per step.
      if (pct && install.log.length && /\d{1,3}%/.test(install.log.at(-1)!)) install.log[install.log.length - 1] = line.slice(0, 300);
      else install.log.push(line.slice(0, 300));
      if (install.log.length > 200) install.log.splice(0, install.log.length - 200);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (e) => {
    Object.assign(install, { state: "error", finishedAt: new Date().toISOString(), error: `The installer could not start: ${e.message}` });
  });
  child.on("close", (code) => {
    if (install.state !== "running") return;
    const ok = code === 0 && fs.existsSync(/* turbopackIgnore: true */ bundledPath(which));
    Object.assign(install, {
      state: ok ? "done" : "error", finishedAt: new Date().toISOString(), percent: ok ? 100 : install.percent,
      error: ok ? null : code === 0 ? "The installer finished but the browser was not found where Playwright expects it." : installError(code),
    });
    log.info("browser.install_finished", { ok, code });
    // The next Browser-mode job launches the new browser.
    if (ok) void closeBrowser();
  });
  return browserStatus();
}

/** The first error line usually names the cause (a blocked download, no disk space); later ones repeat it. */
function installError(code: number | null) {
  const first = install.log.find((l) => /^Error:/.test(l)) ?? install.log.at(-1) ?? "";
  const hint = /403|blocked|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(first) ? " The download was blocked or the network is offline; a firewall, VPN or proxy may be stopping it." : /ENOSPC/i.test(first) ? " The disk is full." : "";
  return `The installer stopped with code ${code}. ${first.slice(0, 240)}${hint}`.trim();
}

/** Starts the chosen browser once and opens a blank page, so the button can say it really works. */
export async function testBrowser() {
  const started = Date.now();
  const exe = executablePath();
  try {
    const b = await chromium.launch({ headless: true, executablePath: exe, timeout: 30_000 });
    try {
      const page = await b.newPage();
      await page.setContent("<title>ok</title>");
      return { ok: true, version: b.version(), ms: Date.now() - started, path: exe ?? bundledPath(), error: null };
    } finally { await b.close().catch(() => undefined); }
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0]!;
    return { ok: false, version: null, ms: Date.now() - started, path: exe ?? bundledPath(), error: /Executable doesn't exist/i.test(msg) ? "The browser is not installed yet." : msg.slice(0, 300) };
  }
}
