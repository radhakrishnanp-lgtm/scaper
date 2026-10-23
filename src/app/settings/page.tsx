"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, Bookmark, Bot, Database, EyeOff, Download, FileUp, Globe, HardDrive, Info, KeyRound, Mail, MessageCircle, Newspaper, Plus, Save, Send, ShieldCheck, Smartphone, Trash2, Webhook, Hash } from "lucide-react";
import { Panel, TestButton, useSection, type S, type SettingsResponse } from "@/components/settings-bits";
import { AiSettings } from "@/components/ai-settings";
import { PrivacySettings } from "@/components/privacy-settings";
import type { ApiToken } from "@/server/repo/tokens";
import type { ImportReport } from "@/server/ops/config";
import { CopyButton } from "@/components/data-table";
import { ConfirmDialog, Dialog } from "@/components/dialog";
import { useToast } from "@/components/toast";
import { Badge, Button, Callout, Card, Code, ErrorNote, Field, Input, Kbd, KeyValue, LoadingRows, PageHeader, Select, Switch, TagInput, Tabs } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { bytes, dateTime, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";

type Tab = "ai" | "scraping" | "alerts" | "data" | "privacy" | "api" | "about";
type Resp = SettingsResponse;


function ScrapingTab({ data, onSaved }: { data: Resp; onSaved: (s: S) => void }) {
  const s = useSection(data.settings.scraping, "scraping", onSaved);
  const v = s.v;
  return (
    <Panel title="Scraping" icon={<Globe className="size-4 text-muted" />} description="Defaults for every task, watcher and price check. Per-site rules on the Sites page can only make Scaper slower."
      footer={<Button icon={<Save className="size-4" />} loading={s.saving} onClick={() => void s.save()}>Save</Button>}>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Wait between requests to a site (s)" error={s.errors.minDelaySeconds}>{(p) => <Input {...p} type="number" min={1} max={600} value={v.minDelaySeconds} onChange={(e) => s.set({ minDelaySeconds: Number(e.target.value) || 1 })} />}</Field>
        <Field label="Page timeout (s)">{(p) => <Input {...p} type="number" min={5} max={120} value={v.timeoutSeconds} onChange={(e) => s.set({ timeoutSeconds: Number(e.target.value) || 30 })} />}</Field>
        <Field label="Jobs at the same time" hint="Different sites run in parallel; one site is always one at a time.">{(p) => <Select {...p} value={v.jobConcurrency} onChange={(e) => s.set({ jobConcurrency: Number(e.target.value) })}>{[1, 2, 3, 4, 5, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}</Select>}</Field>
        <Field label="Browser pages at once">{(p) => <Select {...p} value={v.maxConcurrency} onChange={(e) => s.set({ maxConcurrency: Number(e.target.value) })}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</Select>}</Field>
      </div>
      <Field label="User agent" hint="Empty = Scaper's honest default. Adding your contact details is good manners for heavy use.">{(p) => <Input {...p} value={v.userAgent} onChange={(e) => s.set({ userAgent: e.target.value })} placeholder="Scaper/2 (personal; me@example.com)" />}</Field>
      <NetworkSection value={v.proxyUrl} proxyAi={v.proxyAi} error={s.errors.proxyUrl} onChange={(x) => s.set(x)} />
      <div className="space-y-3">
        <Switch label="Respect robots.txt" description="Recommended. Override per site on the Sites page for sites you own." checked={v.respectRobots} onChange={(x) => s.set({ respectRobots: x })} />
        <Switch label="Skip images, fonts and video in Browser mode" description="Faster and lighter. Screenshots still load images." checked={v.blockHeavyResources} onChange={(x) => s.set({ blockHeavyResources: x })} />
        <Switch label="Allow private network addresses" description="Lets tasks reach 192.168.x.x, localhost and similar. Leave off unless you scrape your own devices." checked={v.allowPrivateNetwork} onChange={(x) => s.set({ allowPrivateNetwork: x })} />
      </div>
    </Panel>
  );
}

type NetTest = { ok: boolean; status: number | null; ms: number; route: string; aiRoute: string; finalUrl?: string; error?: string };
const ROUTE: Record<string, string> = { direct: "Direct (your system network, including a VPN if it is on)", "http-proxy": "Your HTTP proxy", socks5: "Your SOCKS5 proxy", "env-proxy": "The HTTPS_PROXY variable" };

/** Where Scaper's traffic goes: straight out (a system VPN covers that), or through one proxy you control. */
function NetworkSection({ value, proxyAi, error, onChange }: { value: string; proxyAi: boolean; error?: string; onChange: (x: { proxyUrl?: string; proxyAi?: boolean }) => void }) {
  const toast = useToast();
  const [url, setUrl] = useState("https://example.com/");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<NetTest | null>(null);
  const test = async () => {
    setBusy(true); setRes(null);
    try { setRes(await api<NetTest>("/api/settings/network-test", { body: { url } })); }
    catch (e) { toast.error("Test failed", errorText(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="space-y-3 rounded-xl border border-border p-4">
      <div>
        <p className="text-sm font-medium">Network and VPN</p>
        <p className="mt-0.5 text-xs text-muted">A VPN that runs on this computer already covers Scaper; nothing to set. If your VPN app offers a local proxy (often SOCKS5 on 127.0.0.1) or you use an office proxy, enter it here. Scaper still identifies itself, follows robots.txt and keeps its delays either way. Save before testing.</p>
      </div>
      <Field label="Proxy (optional)" hint="http://, https:// or socks5://. Browser mode cannot use a SOCKS5 proxy that needs a password." error={error}>
        {(p) => <Input {...p} className="font-mono text-xs" value={value} onChange={(e) => onChange({ proxyUrl: e.target.value })} placeholder="socks5://127.0.0.1:1080 or http://user:pass@proxy.local:8080" />}
      </Field>
      <Switch label="Send AI requests through it too" description="Off: AI calls go direct (or via HTTPS_PROXY), so a slow proxy does not slow the AI down." checked={proxyAi} onChange={(x) => onChange({ proxyAi: x })} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1"><Field label="Test with this page">{(p) => <Input {...p} value={url} onChange={(e) => setUrl(e.target.value)} />}</Field></div>
        <Button variant="secondary" loading={busy} onClick={() => void test()}>Test connection</Button>
      </div>
      {res && (
        <Callout tone={res.ok ? "success" : "danger"} title={res.ok ? `Loaded in ${res.ms} ms (HTTP ${res.status})` : "Could not load the page"}>
          Route: {ROUTE[res.route] ?? res.route}. AI requests: {ROUTE[res.aiRoute] ?? res.aiRoute}.{res.error ? ` ${res.error}` : ""}
        </Callout>
      )}
    </div>
  );
}

const savedUrlHint = (v: string) => (v.includes("••••") ? "Saved and hidden. Paste a full new URL to replace it, or clear it to remove." : undefined);

function AlertsTab({ data, onSaved }: { data: Resp; onSaved: (s: S) => void }) {
  const s = useSection(data.settings.notifications, "notifications", onSaved);
  const [secrets, setSecrets] = useState({ telegramBotToken: "", ntfyToken: "", smtpPass: "" });
  const v = s.v;
  const save = async () => {
    const extra = Object.fromEntries(Object.entries(secrets).filter(([, x]) => x));
    if (await s.save(extra)) setSecrets({ telegramBotToken: "", ntfyToken: "", smtpPass: "" });
  };
  const saveBtn = <Button icon={<Save className="size-4" />} loading={s.saving} onClick={save}>Save</Button>;
  return (
    <div className="space-y-6">
      <Panel title="Delivery" icon={<Bell className="size-4 text-muted" />} description="Rules for every channel. The in-app inbox always gets every alert." footer={saveBtn}>
        <Switch label="Mute all external channels" description="A quick pause for travel or meetings. Alerts still collect in the inbox." checked={v.muteAll} onChange={(x) => s.set({ muteAll: x })} />
        <div className="rounded-xl border border-border p-3">
          <Switch label="Quiet hours" description="Hold external alerts during these hours; they are sent when quiet hours end." checked={v.quietHoursEnabled} onChange={(x) => s.set({ quietHoursEnabled: x })} />
          {v.quietHoursEnabled && (
            <div className="mt-3 flex gap-3">
              <Field label="From">{(p) => <Input {...p} type="time" className="w-32" value={v.quietStart} onChange={(e) => s.set({ quietStart: e.target.value })} />}</Field>
              <Field label="To">{(p) => <Input {...p} type="time" className="w-32" value={v.quietEnd} onChange={(e) => s.set({ quietEnd: e.target.value })} />}</Field>
            </div>
          )}
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Alert after failed checks in a row" hint="For watchers and tasks that keep failing.">{(p) => <Input {...p} type="number" min={1} max={50} value={v.failureAlertAfter} onChange={(e) => s.set({ failureAlertAfter: Number(e.target.value) || 1 })} />}</Field>
          <Field label="Repeat a failure alert after (min)">{(p) => <Input {...p} type="number" min={0} value={v.errorAlertCooldownMinutes} onChange={(e) => s.set({ errorAlertCooldownMinutes: Number(e.target.value) || 0 })} />}</Field>
        </div>
      </Panel>

      <Panel title="Briefing" icon={<Newspaper className="size-4 text-muted" />} description="A summary of what your watchers saw, tasks that need attention and price alerts, sent to your channels on a schedule."
        footer={<><Link prefetch={false} href="/changes"><Button variant="ghost">Preview in Changes</Button></Link>{saveBtn}</>}>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Send a briefing">{(p) => <Select {...p} value={v.digest} onChange={(e) => s.set({ digest: e.target.value as typeof v.digest })}><option value="off">Never</option><option value="daily">Every day</option><option value="weekly">Every week</option></Select>}</Field>
          {v.digest === "weekly" && <Field label="On">{(p) => <Select {...p} value={v.digestDay} onChange={(e) => s.set({ digestDay: Number(e.target.value) })}>{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => <option key={d} value={i}>{d}</option>)}</Select>}</Field>}
          {v.digest !== "off" && <Field label="At">{(p) => <Select {...p} value={v.digestHour} onChange={(e) => s.set({ digestHour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}</Select>}</Field>}
        </div>
        {v.digest !== "off" && (
          <>
            <div className="grid gap-4 md:grid-cols-[1fr_200px]">
              <Field label="Only watchers with these tags" hint="Empty = every watcher.">{(p) => <TagInput id={p.id} label="Briefing tags" value={v.digestTags} onChange={(x) => s.set({ digestTags: x })} placeholder="competitors, pricing" />}</Field>
              <Field label="Match">{(p) => <Select {...p} value={v.digestTagMatch} onChange={(e) => s.set({ digestTagMatch: e.target.value as "any" | "all" })}><option value="any">Any of the tags</option><option value="all">All of the tags</option></Select>}</Field>
            </div>
            <Switch label="Executive summary by your AI" description="3 to 5 bullet points on top, written by your model from the facts in the briefing. Logged in the AI log." checked={v.digestAi} onChange={(x) => s.set({ digestAi: x })} />
            <Switch label="Skip quiet briefings" description="Don't send one when nothing important changed, no task needs attention and there were no price alerts." checked={v.digestSkipQuiet} onChange={(x) => s.set({ digestSkipQuiet: x })} />
          </>
        )}
      </Panel>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Telegram" icon={<Send className="size-4 text-muted" />} description="Create a bot with @BotFather, send it a message, then use your chat ID." footer={<><TestButton channel="telegram" />{saveBtn}</>}>
          <Field label="Bot token" hint={v.hasTelegramToken ? `Saved (${v.telegramBotToken}).` : undefined}>{(p) => <Input {...p} type="password" autoComplete="off" value={secrets.telegramBotToken} onChange={(e) => setSecrets({ ...secrets, telegramBotToken: e.target.value })} placeholder={v.hasTelegramToken ? "••••••••" : "123456:ABC…"} />}</Field>
          <Field label="Chat ID">{(p) => <Input {...p} value={v.telegramChatId} onChange={(e) => s.set({ telegramChatId: e.target.value })} placeholder="123456789" />}</Field>
        </Panel>
        <Panel title="Email" icon={<Mail className="size-4 text-muted" />} description="Any SMTP server, e.g. Gmail with an app password." footer={<><TestButton channel="email" />{saveBtn}</>}>
          <div className="grid gap-3 sm:grid-cols-[1fr_100px]">
            <Field label="SMTP host">{(p) => <Input {...p} value={v.smtpHost} onChange={(e) => s.set({ smtpHost: e.target.value })} placeholder="smtp.gmail.com" />}</Field>
            <Field label="Port">{(p) => <Input {...p} type="number" value={v.smtpPort} onChange={(e) => s.set({ smtpPort: Number(e.target.value) || 587 })} />}</Field>
            <Field label="User">{(p) => <Input {...p} value={v.smtpUser} onChange={(e) => s.set({ smtpUser: e.target.value })} />}</Field>
            <Field label="Password">{(p) => <Input {...p} type="password" autoComplete="off" value={secrets.smtpPass} onChange={(e) => setSecrets({ ...secrets, smtpPass: e.target.value })} placeholder={v.hasSmtpPass ? "saved" : ""} />}</Field>
            <Field label="From">{(p) => <Input {...p} value={v.emailFrom} onChange={(e) => s.set({ emailFrom: e.target.value })} placeholder="Scaper <me@example.com>" />}</Field>
            <Field label="To">{(p) => <Input {...p} value={v.emailTo} onChange={(e) => s.set({ emailTo: e.target.value })} placeholder="me@example.com" />}</Field>
          </div>
          <Switch label="Use TLS from the start (port 465)" checked={v.smtpSecure} onChange={(x) => s.set({ smtpSecure: x })} />
        </Panel>
        <Panel title="Discord" icon={<MessageCircle className="size-4 text-muted" />} description="Channel settings → Integrations → Webhooks." footer={<><TestButton channel="discord" />{saveBtn}</>}>
          <Field label="Webhook URL" hint={savedUrlHint(v.discordWebhookUrl)}>{(p) => <Input {...p} className="font-mono text-xs" value={v.discordWebhookUrl} onChange={(e) => s.set({ discordWebhookUrl: e.target.value })} placeholder="https://discord.com/api/webhooks/…" />}</Field>
        </Panel>
        <Panel title="Slack" icon={<Hash className="size-4 text-muted" />} description="An incoming webhook from a Slack app you own." footer={<><TestButton channel="slack" />{saveBtn}</>}>
          <Field label="Webhook URL" hint={savedUrlHint(v.slackWebhookUrl)}>{(p) => <Input {...p} className="font-mono text-xs" value={v.slackWebhookUrl} onChange={(e) => s.set({ slackWebhookUrl: e.target.value })} placeholder="https://hooks.slack.com/services/…" />}</Field>
        </Panel>
        <Panel title="ntfy push" icon={<Smartphone className="size-4 text-muted" />} description="Phone push without an account: install the ntfy app and subscribe to a hard-to-guess topic." footer={<><TestButton channel="ntfy" />{saveBtn}</>}>
          <Field label="Topic URL" hint={savedUrlHint(v.ntfyUrl)}>{(p) => <Input {...p} className="font-mono text-xs" value={v.ntfyUrl} onChange={(e) => s.set({ ntfyUrl: e.target.value })} placeholder="https://ntfy.sh/scaper-k7x92q" />}</Field>
          <Field label="Access token (optional)">{(p) => <Input {...p} type="password" autoComplete="off" value={secrets.ntfyToken} onChange={(e) => setSecrets({ ...secrets, ntfyToken: e.target.value })} placeholder={v.ntfyToken ? "saved" : ""} />}</Field>
        </Panel>
        <Panel title="Webhook" icon={<Webhook className="size-4 text-muted" />} description="POSTs JSON to your URL: n8n, Make, Zapier, Home Assistant or your own server. Tasks can also send their rows here." footer={<><TestButton channel="webhook" />{saveBtn}</>}>
          <Field label="URL" hint={savedUrlHint(v.webhookUrl)}>{(p) => <Input {...p} className="font-mono text-xs" value={v.webhookUrl} onChange={(e) => s.set({ webhookUrl: e.target.value })} placeholder="https://hooks.example.com/scaper" />}</Field>
        </Panel>
      </div>
      <p className="text-xs text-muted">Test buttons use the saved settings, so save first. Tokens and passwords are stored only in your local database and are never sent back to the browser.</p>
    </div>
  );
}

type Backup = { name: string; size: number; created_at: string };
type Storage = { usage: { database: number; media: number; exports: number; backups: number; total: number; dataDir: string }; rows: Record<string, number> };

function DataTab({ data, onSaved }: { data: Resp; onSaved: (s: S) => void }) {
  const toast = useToast();
  const s = useSection(data.settings.data, "data", onSaved);
  const backups = useApi<{ backups: Backup[] }>("/api/backups");
  const storage = useApi<Storage>("/api/storage");
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<string | null>(null);
  const v = s.v;
  const backupNow = async () => {
    setBusy(true);
    try { const r = await api<{ job: { status: string; error: string | null } }>("/api/backups", { method: "POST" }); if (r.job.status === "succeeded") toast.success("Backup saved"); else toast.error("Backup failed", r.job.error ?? undefined); void backups.reload(); void storage.reload(); }
    catch (e) { toast.error("Backup failed", errorText(e)); } finally { setBusy(false); }
  };
  const remove = async (name: string) => {
    try { await api(`/api/backups/${encodeURIComponent(name)}`, { method: "DELETE" }); toast.success("Backup deleted"); setDel(null); void backups.reload(); }
    catch (e) { toast.error("Could not delete", errorText(e)); }
  };
  const u = storage.data?.usage;
  return (
    <div className="space-y-6">
      <Panel title="Storage" icon={<HardDrive className="size-4 text-muted" />} description={u ? <>Everything lives in <Code>{u.dataDir}</Code> on this computer.</> : undefined}>
        {u ? (
          <>
            <div className="flex h-3 overflow-hidden rounded-full bg-surface-2" role="img" aria-label="Storage breakdown">
              {[{ k: "database", c: "bg-accent" }, { k: "media", c: "bg-warning" }, { k: "exports", c: "bg-success" }, { k: "backups", c: "bg-muted" }].map(({ k, c }) => {
                const n = u[k as keyof typeof u] as number;
                return n > 0 ? <div key={k} className={`${c} border-r-2 border-surface last:border-r-0`} style={{ width: `${Math.max(1, (n / Math.max(1, u.total)) * 100)}%` }} title={`${k}: ${bytes(n)}`} /> : null;
              })}
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
              {[["Database", u.database, "bg-accent"], ["Screenshots", u.media, "bg-warning"], ["Exported files", u.exports, "bg-success"], ["Backups", u.backups, "bg-muted"], ["Total", u.total, ""]].map(([l, n, c]) => (
                <div key={l as string}><p className="flex items-center gap-1.5 text-xs text-muted">{c ? <span className={`size-2 rounded-full ${c}`} /> : null}{l}</p><p className="font-semibold tabular-nums">{bytes(n as number)}</p></div>
              ))}
            </div>
            <p className="text-xs text-muted">{Object.entries(storage.data!.rows).map(([k, n]) => `${n.toLocaleString("en-IN")} ${k.replace(/([A-Z])/g, " $1").toLowerCase()}`).join(" · ")}</p>
          </>
        ) : <div className="skeleton h-20 rounded-lg" />}
      </Panel>

      <Panel title="Keep" description="Older items are cleaned up automatically every 6 hours. Lower numbers keep the database small and fast." footer={<Button icon={<Save className="size-4" />} loading={s.saving} onClick={() => void s.save()}>Save</Button>}>
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="Scrape results" error={s.errors.keepRuns}>{(p) => <Input {...p} type="number" min={20} value={v.keepRuns} onChange={(e) => s.set({ keepRuns: Number(e.target.value) || 20 })} />}</Field>
          <Field label="Snapshots per watcher">{(p) => <Input {...p} type="number" min={10} value={v.keepSnapshots} onChange={(e) => s.set({ keepSnapshots: Number(e.target.value) || 10 })} />}</Field>
          <Field label="Job history (days)">{(p) => <Input {...p} type="number" min={1} max={365} value={v.keepJobsDays} onChange={(e) => s.set({ keepJobsDays: Number(e.target.value) || 1 })} />}</Field>
          <Field label="Logs (days)">{(p) => <Input {...p} type="number" min={1} max={365} value={v.keepEventsDays} onChange={(e) => s.set({ keepEventsDays: Number(e.target.value) || 1 })} />}</Field>
        </div>
        <div className="flex flex-wrap items-end gap-6">
          <Switch label="Back up once a day" description="Taken while Scaper runs; the oldest beyond the limit are removed." checked={v.autoBackup} onChange={(x) => s.set({ autoBackup: x })} />
          <Field label="Backups to keep">{(p) => <Input {...p} type="number" min={1} max={60} className="w-28" value={v.keepBackups} onChange={(e) => s.set({ keepBackups: Number(e.target.value) || 1 })} />}</Field>
        </div>
      </Panel>

      <Panel title="Backups" icon={<Database className="size-4 text-muted" />} description="A consistent copy of the whole database, safe to take while Scaper runs."
        footer={<><a href="/api/data/export"><Button variant="secondary" icon={<Download className="size-4" />}>JSON export</Button></a><Button icon={<Plus className="size-4" />} loading={busy} onClick={backupNow}>Back up now</Button></>}>
        {!backups.data ? <div className="skeleton h-16 rounded-lg" /> : !backups.data.backups.length ? <p className="text-sm text-muted">No backups yet.</p> : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {backups.data.backups.map((b) => (
              <li key={b.name} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{b.name}</span>
                <span className="text-muted tabular-nums">{bytes(b.size)}</span>
                <span className="text-muted" title={dateTime(b.created_at)}>{timeAgo(b.created_at)}</span>
                <a href={`/api/backups/${encodeURIComponent(b.name)}`} download className="text-accent hover:underline">Download</a>
                <button type="button" className="text-muted hover:text-danger" onClick={() => setDel(b.name)} aria-label={`Delete ${b.name}`}><Trash2 className="size-4" /></button>
              </li>
            ))}
          </ul>
        )}
        <Callout title="To restore">Stop Scaper, copy the backup over <Code>data/scaper.db</Code> (and delete <Code>scaper.db-wal</Code> if present), then start it again. Details in docs/RUNBOOK.md.</Callout>
      </Panel>
      <ConfirmDialog open={Boolean(del)} onCancel={() => setDel(null)} onConfirm={() => del && void remove(del)} title="Delete this backup?" body={del} />
    </div>
  );
}

/** React blocks javascript: URLs in href, so the bookmarklet's link is set on the element directly. */
function Bookmarklet({ label, js, onClick }: { label: string; js: string; onClick: () => void }) {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => { ref.current?.setAttribute("href", js); }, [js]);
  return (
    <a ref={ref} onClick={(e) => { e.preventDefault(); onClick(); }} draggable className="inline-flex h-9 cursor-grab items-center gap-2 rounded-lg border border-dashed border-accent px-3 text-sm font-medium text-accent">
      <Bookmark className="size-4" />{label}
    </a>
  );
}

function ApiTab() {
  const toast = useToast();
  const tokens = useApi<{ tokens: ApiToken[] }>("/api/tokens");
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoke, setRevoke] = useState<ApiToken | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [origin, setOrigin] = useState("http://localhost:3000");
  useEffect(() => {
    // window is only available after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOrigin(window.location.origin);
  }, []);
  const create = async () => {
    setBusy(true);
    try { const r = await api<{ token: string }>("/api/tokens", { body: { name } }); setCreated(r.token); setName(""); void tokens.reload(); }
    catch (e) { toast.error("Could not create", errorText(e)); } finally { setBusy(false); }
  };
  const doRevoke = async (t: ApiToken) => {
    try { await api(`/api/tokens/${t.id}`, { method: "DELETE" }); toast.success("Token revoked", t.name); setRevoke(null); void tokens.reload(); }
    catch (e) { toast.error("Could not revoke", errorText(e)); }
  };
  const importFile = async (file: File) => {
    try {
      const res = await fetch("/api/config", { method: "POST", body: await file.text(), headers: { "content-type": "application/json" } });
      const body = await res.json() as { report?: ImportReport; error?: { message: string } };
      if (!res.ok || !body.report) throw new Error(body.error?.message ?? "Import failed.");
      setReport(body.report);
    } catch (e) { toast.error("Import failed", errorText(e)); }
  };
  const marks = [
    { label: "Scrape this page", js: `javascript:window.open('${origin}/scrape?url='+encodeURIComponent(location.href))` },
    { label: "Watch this page", js: `javascript:window.open('${origin}/watchers/new?url='+encodeURIComponent(location.href)+'&name='+encodeURIComponent(document.title))` },
    { label: "Track this price", js: `javascript:window.open('${origin}/deals?track='+encodeURIComponent(location.href))` },
  ];
  const examples = [
    { label: "List your tasks", cmd: `curl -H "Authorization: Bearer $SCAPER_TOKEN" ${origin}/api/tasks` },
    { label: "Scrape a page (waits for the result)", cmd: `curl -X POST -H "Authorization: Bearer $SCAPER_TOKEN" -H "content-type: application/json" \\\n  -d '{"url":"https://example.com","mode":"fast","extract":{"type":"auto"}}' ${origin}/api/scrape` },
    { label: "Recent alerts", cmd: `curl -H "Authorization: Bearer $SCAPER_TOKEN" "${origin}/api/notifications?limit=10"` },
  ];
  return (
    <div className="space-y-6">
      <Panel title="API tokens" icon={<KeyRound className="size-4 text-muted" />} description="For scripts, cron jobs, n8n or Home Assistant on this computer or your network. Every page's API works with a token.">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <Input aria-label="Token name" value={name} onChange={(e) => setName(e.target.value)} placeholder="n8n on the NAS" maxLength={80} />
          <Button type="submit" loading={busy} disabled={!name.trim()} icon={<Plus className="size-4" />}>Create</Button>
        </form>
        {!tokens.data ? <div className="skeleton h-12 rounded-lg" /> : tokens.data.tokens.length > 0 && (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {tokens.data.tokens.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <span className="font-medium">{t.name}</span>
                <Code>{t.prefix}…</Code>
                <span className="flex-1 text-xs text-muted">created {timeAgo(t.created_at)} · {t.last_used_at ? `used ${timeAgo(t.last_used_at)}` : "never used"}</span>
                {t.revoked_at ? <Badge>revoked</Badge> : <Button size="sm" variant="ghost" onClick={() => setRevoke(t)}>Revoke</Button>}
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-3">
          {examples.map((x) => (
            <div key={x.label}>
              <div className="mb-1 flex items-center justify-between text-sm"><span className="font-medium">{x.label}</span><CopyButton text={x.cmd} /></div>
              <pre className="scroll-thin overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">{x.cmd}</pre>
            </div>
          ))}
          <p className="text-xs text-muted">Every route is listed in docs/API.md.</p>
        </div>
      </Panel>

      <Panel title="Bookmarklets" icon={<Bookmark className="size-4 text-muted" />} description="Drag these to your bookmarks bar. On any page, click one to send that page to Scaper.">
        <div className="flex flex-wrap gap-2">
          {marks.map((m) => <Bookmarklet key={m.label} label={m.label} js={m.js} onClick={() => toast.info("Drag it to your bookmarks bar", "Clicking it here does nothing.")} />)}
        </div>
      </Panel>

      <Panel title="Move your setup" icon={<FileUp className="size-4 text-muted" />} description="Tasks, watchers, products, deal searches and site rules as one JSON file. Secrets and cookies are left out.">
        <div className="flex flex-wrap gap-2">
          <a href="/api/config" download><Button variant="secondary" icon={<Download className="size-4" />}>Export setup</Button></a>
          <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-border px-4 text-sm font-medium hover:bg-surface-2">
            <FileUp className="size-4" />Import setup
            <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ""; }} />
          </label>
        </div>
        <p className="text-xs text-muted">Import only adds; items that already exist (same name and URL) are skipped.</p>
      </Panel>

      <Dialog open={Boolean(created)} onClose={() => setCreated(null)} title="Your new token" description="Copy it now. Scaper stores only a hash and can't show it again." footer={<Button onClick={() => setCreated(null)}>Done</Button>}>
        <div className="flex items-center gap-2"><Code className="flex-1 break-all p-2">{created}</Code><CopyButton text={created ?? ""} /></div>
      </Dialog>
      <Dialog open={Boolean(report)} onClose={() => setReport(null)} title="Import finished" footer={<Button onClick={() => setReport(null)}>Done</Button>}>
        {report && <KeyValue items={Object.entries(report).map(([k, r]) => ({ label: k.replace(/([A-Z])/g, " $1"), value: <span>{r.added} added · {r.skipped} skipped{r.errors.length ? <span className="block text-xs text-danger">{r.errors.slice(0, 3).join("; ")}</span> : null}</span> }))} />}
      </Dialog>
      <ConfirmDialog open={Boolean(revoke)} onCancel={() => setRevoke(null)} onConfirm={() => revoke && void doRevoke(revoke)} confirmLabel="Revoke" title={`Revoke “${revoke?.name}”?`} body="Anything using it stops working immediately." />
    </div>
  );
}

function AboutTab({ data }: { data: Resp }) {
  const health = useApi<{ ok: boolean; database: string; scheduler: string; browser: string; version?: string }>("/api/health");
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel title="Status" icon={<Info className="size-4 text-muted" />}>
        <KeyValue items={[
          { label: "Version", value: health.data?.version ?? "—" },
          { label: "Database", value: health.data ? <Badge tone={health.data.database === "ok" ? "success" : "danger"}>{health.data.database}</Badge> : "…" },
          { label: "Scheduler", value: health.data ? <Badge tone={health.data.scheduler === "running" ? "success" : "warning"}>{health.data.scheduler}</Badge> : "…" },
          { label: "Browser", value: health.data ? <Badge tone={health.data.browser === "installed" ? "success" : "warning"}>{health.data.browser}</Badge> : "…" },
          { label: "Password", value: data.passwordProtected ? "On (SCAPER_APP_PASSWORD)" : "Off: anyone who can reach this port can use Scaper" },
        ]} />
        {health.data?.browser === "missing" && <Callout tone="warning" title="Browser mode is not available">Run <Code>npx playwright install chromium</Code> once, then restart.</Callout>}
      </Panel>
      <Panel title="Keyboard" description="Works on every page.">
        <KeyValue items={[
          { label: "Search & commands", value: <span className="flex gap-1"><Kbd>Ctrl</Kbd><Kbd>K</Kbd> or <Kbd>/</Kbd></span> },
          { label: "Save a form", value: <span className="flex gap-1"><Kbd>Ctrl</Kbd><Kbd>S</Kbd></span> },
          { label: "Close a dialog", value: <Kbd>Esc</Kbd> },
        ]} />
      </Panel>
      <Panel title="What Scaper never does" icon={<ShieldCheck className="size-4 text-muted" />}>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>Solve CAPTCHAs, spoof browser fingerprints or rotate proxy pools.</li>
          <li>Run code your AI model writes, or follow instructions found on scraped pages.</li>
          <li>Send your keys, tokens, passwords or cookies to the browser, logs or exports.</li>
          <li>Phone home. Everything runs and stays on this computer.</li>
        </ul>
      </Panel>
      <Panel title="Help">
        <ul className="space-y-1 text-sm">
          <li><Link prefetch={false} href="/tasks/new" className="text-accent hover:underline">Start a task from a template</Link></li>
          <li><Link prefetch={false} href="/watchers/new" className="text-accent hover:underline">Create a watcher</Link></li>
          <li className="text-muted">Guides in the docs folder: README, RUNBOOK (backups, restore, troubleshooting), API, SECURITY.</li>
        </ul>
      </Panel>
    </div>
  );
}

function SettingsPage() {
  const { data, error, loading, reload, setData } = useApi<Resp>("/api/settings");
  const [tab, setTab] = useQueryState<Tab>("tab", "ai");
  const onSaved = (s: S) => setData((d) => d && { ...d, settings: s });
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  return (
    <>
      <PageHeader title="Settings" description="Everything is stored in your local database. Secrets never reach the browser." />
      <Tabs value={tab} onChange={setTab} className="mb-6" tabs={[
        { value: "ai", label: "AI", icon: <Bot className="size-4" /> },
        { value: "scraping", label: "Scraping", icon: <Globe className="size-4" /> },
        { value: "alerts", label: "Alerts", icon: <Bell className="size-4" /> },
        { value: "data", label: "Data & backups", icon: <Database className="size-4" /> },
        { value: "privacy", label: "Privacy", icon: <EyeOff className="size-4" /> },
        { value: "api", label: "API & import", icon: <KeyRound className="size-4" /> },
        { value: "about", label: "About", icon: <Info className="size-4" /> },
      ]} />
      {loading || !data ? <Card><LoadingRows /></Card> : (
        <>
          {tab === "ai" && <AiSettings data={data} onSaved={onSaved} />}
          {tab === "scraping" && <ScrapingTab data={data} onSaved={onSaved} />}
          {tab === "alerts" && <AlertsTab data={data} onSaved={onSaved} />}
          {tab === "data" && <DataTab data={data} onSaved={onSaved} />}
          {tab === "privacy" && <PrivacySettings data={data} onSaved={onSaved} />}
          {tab === "api" && <ApiTab />}
          {tab === "about" && <AboutTab data={data} />}
        </>
      )}
    </>
  );
}

export default function Page() {
  return <Suspense><SettingsPage /></Suspense>;
}
