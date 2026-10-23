"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Download, MonitorCheck, Play, X } from "lucide-react";
import { useToast } from "@/components/toast";
import { Badge, Button, Field, Input, Progress } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { useApi } from "@/lib/use-api";

type Status = {
  ready: boolean; source: "env" | "chosen" | "bundled"; path: string; chosen: string; chosenMissing: boolean;
  bundled: { installed: boolean; path: string };
  system: { name: string; path: string }[];
  install: { state: "idle" | "running" | "done" | "error"; log: string[]; error: string | null; percent: number | null };
};
type TestResult = { ok: boolean; version: string | null; ms: number; path: string; error: string | null };

/** Browser mode set-up: one-click install, or a Chrome/Edge/Brave already on this computer. */
export function BrowserSetup({ compact, onPathSaved, onReady }: { compact?: boolean; onPathSaved?: (path: string) => void; onReady?: () => void }) {
  const toast = useToast();
  const [watching, setWatching] = useState(false);
  const status = useApi<Status>("/api/system/browser", { pollMs: watching ? 1000 : undefined });
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [custom, setCustom] = useState("");
  const [customError, setCustomError] = useState<string | undefined>();
  const st = status.data;
  const running = st?.install.state === "running";

  const install = async () => {
    setBusy("install"); setTest(null);
    try { await api("/api/system/browser", { body: { action: "install" } }); }
    catch (e) { toast.error("Could not start the install", errorText(e)); setBusy(null); return; }
    setBusy(null);
    // The effect below follows the install as soon as the status says it is running.
    void status.reload();
  };
  /** Shows progress until the install ends, then tells the page so it can tick its set-up step. */
  const follow = async () => {
    setWatching(true);
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const now = await api<Status>("/api/system/browser").catch(() => null);
        if (!now || now.install.state === "running") continue;
        if (now.install.state === "done") { toast.success("Browser installed", "Browser mode is ready."); onReady?.(); }
        break;
      }
    } finally { setWatching(false); void status.reload(); }
  };
  // An install started earlier, or on another page, is followed too.
  const following = useRef(false);
  const installState = st?.install.state;
  useEffect(() => {
    if (installState !== "running" || following.current) return;
    following.current = true;
    void follow().finally(() => { following.current = false; });
  });
  const runTest = async () => {
    setBusy("test"); setTest(null);
    try { const r = await api<{ test: TestResult }>("/api/system/browser", { body: { action: "test" } }); setTest(r.test); void status.reload(); }
    catch (e) { toast.error("Test failed", errorText(e)); }
    finally { setBusy(null); }
  };
  const choose = async (path: string) => {
    setBusy(path || "bundled"); setCustomError(undefined); setTest(null);
    try {
      await api("/api/settings", { method: "PUT", body: { scraping: { browserPath: path } } });
      onPathSaved?.(path);
      toast.success(path ? "Browser chosen" : "Using Scaper's browser");
      void status.reload();
      if (path) onReady?.();
      return true;
    } catch (e) {
      const msg = errorText(e);
      if (!path) toast.error("Could not save", msg); else setCustomError(msg.includes("Chrome") ? msg : "Choose the full path of Chrome, Edge, Brave or Chromium on this computer");
      return false;
    } finally { setBusy(null); }
  };

  if (!st) return <p className="text-sm text-muted">Checking the browser…</p>;
  const label = st.source === "env" ? "Set by PLAYWRIGHT_EXECUTABLE_PATH" : st.source === "chosen" ? (st.system.find((s) => s.path === st.path)?.name ?? "Your browser") : "Chromium installed by Scaper";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {st.ready ? <Badge tone="success"><Check className="size-3" />Ready</Badge> : <Badge tone="warning"><X className="size-3" />Not installed</Badge>}
        <span className="font-medium">{st.ready ? label : "Browser mode needs a browser"}</span>
        {st.ready && <span className="min-w-0 truncate font-mono text-xs text-muted" title={st.path}>{st.path}</span>}
      </div>
      {st.chosenMissing && <p className="text-sm text-warning">The browser you chose is no longer at {st.chosen}. Scaper uses its own browser until you choose another.</p>}

      {running ? (
        <div className="space-y-1.5">
          <Progress value={st.install.percent} label="Installing the browser" />
          <p className="truncate text-xs text-muted">{st.install.log.at(-1) ?? "Starting the download…"}</p>
          <p className="text-xs text-muted">About 150 MB, once. You can leave this page; it keeps going.</p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {!st.ready && st.source !== "env" && (
            <Button size="sm" icon={<Download className="size-4" />} loading={busy === "install"} onClick={() => void install()}>Install browser</Button>
          )}
          {st.ready && <Button size="sm" variant="secondary" icon={<Play className="size-4" />} loading={busy === "test"} onClick={() => void runTest()}>Test browser</Button>}
        </div>
      )}
      {!st.ready && st.install.state === "error" && st.install.error && (
        <div className="rounded-lg border border-danger/30 bg-danger-soft/40 p-2 text-sm">
          <p className="font-medium text-danger">The install did not finish</p>
          <p className="text-xs">{st.install.error}</p>
          <p className="mt-1 text-xs text-muted">You can also run <code className="font-mono">npm run setup:browser</code> in the project folder, or use a browser already on this computer {compact ? "in Settings → Scraping" : "below"}.</p>
        </div>
      )}
      {test && (
        <p className={`text-sm ${test.ok ? "text-success" : "text-danger"}`}>
          {test.ok ? `It works: ${test.version} started in ${(test.ms / 1000).toFixed(1)} s.` : `It did not start: ${test.error}`}
        </p>
      )}

      {!compact && st.source !== "env" && (
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-sm font-medium">Or use a browser on this computer</p>
          {st.system.length ? (
            <ul className="space-y-1.5">
              {st.system.map((b) => {
                const active = st.source === "chosen" && st.path === b.path;
                return (
                  <li key={b.path} className="flex flex-wrap items-center gap-2 text-sm">
                    <MonitorCheck className="size-4 text-muted" />
                    <span className="font-medium">{b.name}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={b.path}>{b.path}</span>
                    {active ? <Badge tone="accent">in use</Badge> : <Button size="sm" variant="secondary" loading={busy === b.path} onClick={() => void choose(b.path)}>Use this</Button>}
                  </li>
                );
              })}
            </ul>
          ) : <p className="text-xs text-muted">No Chrome, Edge, Brave or Chromium found in the usual places.</p>}
          <form className="flex flex-wrap items-start gap-2" onSubmit={(e) => { e.preventDefault(); void choose(custom.trim()).then((ok) => ok && setCustom("")); }}>
            <div className="min-w-0 flex-1">
              <Field label="Browser file (optional)" error={customError} hint="For example C:\Program Files\Google\Chrome\Application\chrome.exe">
                {(f) => <Input {...f} className="font-mono text-xs" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Full path to chrome, msedge or brave" />}
              </Field>
            </div>
            <Button type="submit" size="sm" variant="secondary" className="mt-6" disabled={!custom.trim()} loading={busy === custom.trim() && Boolean(custom.trim())}>Use</Button>
          </form>
          {st.source === "chosen" && <Button size="sm" variant="ghost" loading={busy === "bundled"} onClick={() => void choose("")}>Use Scaper&apos;s own browser instead</Button>}
          <p className="text-xs text-muted">Scaper starts it in the background with a fresh profile, so your own tabs, logins and history are never touched.</p>
        </div>
      )}
    </div>
  );
}
