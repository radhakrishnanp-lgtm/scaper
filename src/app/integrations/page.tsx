"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { Bot, CheckCircle2, Clock, FileSpreadsheet, KeyRound, Lock, Plug, Plus, RefreshCw, RotateCcw, Save, Send, Trash2, Webhook, XCircle } from "lucide-react";
import { WEBHOOK_EVENTS, type WebhookEndpoint } from "@/lib/schemas";
import type { Delivery } from "@/server/repo/deliveries";
import { CopyButton } from "@/components/data-table";
import { Dialog } from "@/components/dialog";
import { Panel, useSection, type S, type SettingsResponse } from "@/components/settings-bits";
import { useToast } from "@/components/toast";
import { Badge, Button, Callout, Card, CardHeader, Checkbox, Code, EmptyState, ErrorNote, Field, FilterChips, Input, LoadingRows, PageHeader, Segmented, Stat, Switch, Tabs, Textarea } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { dateTime, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";

type Tab = "mcp" | "webhooks" | "sheets" | "deliveries";
type Status = {
  mcp: { enabled: boolean; allowWrite: boolean; tools: { name: string; description: string; changes: boolean }[]; tokens: number; bridge: string };
  webhooks: { default: boolean; endpoints: number; retries: boolean; week: { total: number; ok: number; failed: number; retrying: number } };
  sheets: { configured: boolean; email: string | null; tasks: { id: string; name: string; sheet: string; mode: string }[]; week: { total: number; ok: number; failed: number } };
};

const EVENT_LABEL: Record<(typeof WEBHOOK_EVENTS)[number], string> = {
  "task.finished": "Task finished", "task.failed": "Task failed", "task.health": "Task health", "watcher.change": "Watcher change", price: "Price alert", alert: "Other alerts",
};

function Snippet({ label, code }: { label: string; code: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2"><p className="text-sm font-medium">{label}</p><CopyButton text={code} /></div>
      <pre className="scroll-thin overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs leading-relaxed">{code}</pre>
    </div>
  );
}

function McpTab({ data, status, onSaved }: { data: SettingsResponse; status: Status; onSaved: (s: S) => void }) {
  const s = useSection(data.settings.integrations, "integrations", onSaved);
  const [client, setClient] = useState<"claude-code" | "desktop" | "cursor">("claude-code");
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const origin = typeof window === "undefined" ? "http://127.0.0.1:3000" : window.location.origin;
  const url = `${origin}/api/mcp`;
  const token = "scp_YOUR_TOKEN";
  const snippets = {
    "claude-code": { label: "Run in a terminal", code: `claude mcp add --transport http scaper ${url} \\\n  --header "Authorization: Bearer ${token}"` },
    desktop: { label: "claude_desktop_config.json", code: JSON.stringify({ mcpServers: { scaper: { command: "node", args: [status.mcp.bridge], env: { SCAPER_URL: origin, SCAPER_TOKEN: token } } } }, null, 2) },
    cursor: { label: ".cursor/mcp.json", code: JSON.stringify({ mcpServers: { scaper: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2) },
  };
  const runTest = async () => {
    setTesting(true);
    try {
      const init = await api<{ result?: { serverInfo: { title: string; version: string }; protocolVersion: string } }>("/api/mcp", { body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "scaper-ui", version: "1" } } } });
      const list = await api<{ result?: { tools: unknown[] } }>("/api/mcp", { body: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
      setTest({ ok: true, text: `${init.result?.serverInfo.title} answered (protocol ${init.result?.protocolVersion}) with ${list.result?.tools.length ?? 0} tools.` });
    } catch (e) { setTest({ ok: false, text: errorText(e) }); } finally { setTesting(false); }
  };
  const reads = status.mcp.tools.filter((t) => !t.changes);
  const writes = status.mcp.tools.filter((t) => t.changes);
  return (
    <div className="space-y-6">
      <Panel title="MCP server" icon={<Bot className="size-4 text-muted" />}
        description="Let AI apps such as Claude Code, Claude Desktop and Cursor use Scaper: find tasks, read data, check health, triage changes and write briefings. They connect with an API token, only from this computer unless you expose it."
        footer={<><Button size="sm" variant="secondary" loading={testing} onClick={() => void runTest()}>Test the server</Button><Button icon={<Save className="size-4" />} loading={s.saving} onClick={() => void s.save()}>Save</Button></>}>
        <Switch label="MCP server on" description={`Answers at ${url}`} checked={s.v.mcpEnabled} onChange={(x) => s.set({ mcpEnabled: x })} />
        <Switch label="Allow changes" description="Also offer tools that create, run, change or delete things. MCP apps have no approval card like Scaper's own agent does, so leave this off unless you trust the app and its prompts." checked={s.v.mcpAllowWrite} onChange={(x) => s.set({ mcpAllowWrite: x })} />
        {test && <Callout tone={test.ok ? "success" : "danger"} title={test.ok ? "The server works" : "The test failed"}>{test.text}</Callout>}
      </Panel>
      <Card>
        <CardHeader title="Connect an app" description={<>Create a token in <Link prefetch={false} href="/settings?tab=api" className="text-accent hover:underline">Settings → API</Link> ({status.mcp.tokens} so far) and put it in place of <Code>{token}</Code>.</>}
          actions={<Segmented label="App" value={client} onChange={setClient} options={[{ value: "claude-code", label: "Claude Code" }, { value: "desktop", label: "Claude Desktop" }, { value: "cursor", label: "Cursor" }]} />} />
        <div className="space-y-3 px-5 pb-5">
          <Snippet {...snippets[client]} />
          {client === "desktop" && <p className="text-xs text-muted">Claude Desktop starts local servers, so it uses the small bridge script that ships with Scaper. It needs Node 20 or newer.</p>}
        </div>
      </Card>
      <Card>
        <CardHeader title={`Tools (${s.v.mcpAllowWrite ? status.mcp.tools.length : reads.length} offered)`} description="The same tools as Scaper's agent, minus its private browser. Scraped page text is passed as data, never as instructions." />
        <div className="grid gap-x-6 px-5 pb-5 md:grid-cols-2">
          {[{ title: "Read", items: reads, on: true }, { title: "Change", items: writes, on: s.v.mcpAllowWrite }].map((g) => (
            <div key={g.title}>
              <p className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted uppercase">{g.title}{!g.on && <Badge><Lock className="size-3" />off</Badge>}</p>
              <ul className={cn("space-y-1.5", !g.on && "opacity-50")}>
                {g.items.map((t) => <li key={t.name} className="text-sm"><code className="font-mono text-xs font-semibold">{t.name}</code> <span className="text-muted">· {t.description.split(". ")[0]}</span></li>)}
              </ul>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

const newId = () => Math.random().toString(36).slice(2, 10);

function WebhooksTab({ data, status, onSaved }: { data: SettingsResponse; status: Status; onSaved: (s: S) => void }) {
  const toast = useToast();
  const s = useSection(data.settings.integrations, "integrations", onSaved);
  const [testing, setTesting] = useState<string | null>(null);
  const hooks = s.v.webhooks as WebhookEndpoint[];
  const setHook = (i: number, patch: Partial<WebhookEndpoint>) => s.set({ webhooks: hooks.map((h, j) => (j === i ? { ...h, ...patch } : h)) });
  const test = async (h: WebhookEndpoint) => {
    setTesting(h.id);
    try { const r = await api<{ message: string }>("/api/integrations/webhooks/test", { body: { id: h.id, url: h.url, secret: h.secret } }); toast.success("It works", r.message); }
    catch (e) { toast.error("Test failed", errorText(e)); } finally { setTesting(null); }
  };
  const w = status.webhooks.week;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Sent, 7 days" value={w.total} />
        <Stat label="Delivered" value={<span className="text-success">{w.ok}</span>} />
        <Stat label="Retrying" value={w.retrying} />
        <Stat label="Failed" value={<span className={w.failed ? "text-danger" : undefined}>{w.failed}</span>} />
      </div>
      <Panel title="Endpoints" icon={<Webhook className="size-4 text-muted" />}
        description={<>Each endpoint gets the events you pick as signed JSON (<Code>x-scaper-signature</Code> is an HMAC-SHA256 of the body with the secret). The single URL in <Link prefetch={false} href="/settings?tab=alerts" className="text-accent hover:underline">Settings → Alerts</Link> {status.webhooks.default ? "is also used" : "works too"}.</>}
        footer={<Button icon={<Save className="size-4" />} loading={s.saving} onClick={() => void s.save()}>Save</Button>}>
        {!hooks.length && <p className="text-sm text-muted">No endpoints yet. Add one for n8n, Make, Zapier, a Slack workflow or your own server.</p>}
        {hooks.map((h, i) => (
          <div key={h.id} className={cn("space-y-3 rounded-xl border border-border p-4", !h.enabled && "opacity-70")}>
            <div className="grid gap-3 md:grid-cols-[200px_1fr]">
              <Field label="Name" error={s.errors[`webhooks.${i}.name`]}>{(p) => <Input {...p} value={h.name} onChange={(e) => setHook(i, { name: e.target.value })} placeholder="n8n" />}</Field>
              <Field label="URL" error={s.errors[`webhooks.${i}.url`]} hint={h.url.includes("••••") ? "Saved and hidden. Paste a new URL to replace it." : undefined}>{(p) => <Input {...p} className="font-mono text-xs" value={h.url} onChange={(e) => setHook(i, { url: e.target.value })} placeholder="https://n8n.example.com/webhook/scaper" />}</Field>
            </div>
            <Field label="Signing secret (optional)" hint={h.secret.includes("••••") ? "Saved and hidden." : "Your server checks the signature with this."}>{(p) => <Input {...p} type="password" autoComplete="off" className="font-mono text-xs" value={h.secret} onChange={(e) => setHook(i, { secret: e.target.value })} />}</Field>
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium">Events</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {WEBHOOK_EVENTS.map((ev) => (
                  <Checkbox key={ev} label={EVENT_LABEL[ev]} checked={h.events.includes(ev)} onChange={(v) => setHook(i, { events: v ? [...h.events, ev] : h.events.filter((x) => x !== ev) })} />
                ))}
              </div>
            </fieldset>
            <div className="flex flex-wrap items-center gap-2">
              <Switch label="On" checked={h.enabled} onChange={(x) => setHook(i, { enabled: x })} />
              <span className="flex-1" />
              <Link prefetch={false} href={`/integrations?tab=deliveries&target=${h.id}`}><Button size="sm" variant="ghost">Deliveries</Button></Link>
              <Button size="sm" variant="secondary" icon={<Send className="size-4" />} loading={testing === h.id} onClick={() => void test(h)}>Send test</Button>
              <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => s.set({ webhooks: hooks.filter((_, j) => j !== i) })}>Remove</Button>
            </div>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} disabled={hooks.length >= 10}
            onClick={() => s.set({ webhooks: [...hooks, { id: newId(), name: "", url: "", secret: "", events: [...WEBHOOK_EVENTS], enabled: true }] })}>Add endpoint</Button>
          <span className="flex-1" />
          <Switch label="Retry failed deliveries" description="30 s, 2 min, 10 min, 1 h and 6 h after a failure." checked={s.v.webhookRetries} onChange={(x) => s.set({ webhookRetries: x })} />
        </div>
      </Panel>
      <Card className="p-5 text-sm">
        <p className="font-medium">Payload</p>
        <pre className="scroll-thin mt-2 overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">{`POST <your url>
content-type: application/json
x-scaper-event: task.finished
x-scaper-delivery: <id, the same on every retry>
x-scaper-signature: sha256=<hex HMAC of the body>

{ "event": "task.finished", "sentAt": "…", "data": { "task": {…}, "rows": [...], "validation": {…} } }`}</pre>
      </Card>
    </div>
  );
}

function SheetsTab({ data, status, onSaved }: { data: SettingsResponse; status: Status; onSaved: (s: S) => void }) {
  const toast = useToast();
  const s = useSection(data.settings.integrations, "integrations", onSaved);
  const [key, setKey] = useState("");
  const [sheet, setSheet] = useState("");
  const [testing, setTesting] = useState(false);
  const email = data.settings.integrations.serviceAccountEmail;
  const save = async () => { if (await s.save(key ? { googleServiceAccount: key } : {})) setKey(""); };
  const test = async () => {
    setTesting(true);
    try { const r = await api<{ message: string }>("/api/integrations/sheets/test", { body: { spreadsheet: sheet } }); toast.success("Connected", r.message); }
    catch (e) { toast.error("Could not open the sheet", errorText(e)); } finally { setTesting(false); }
  };
  return (
    <div className="space-y-6">
      <Panel title="Google Sheets" icon={<FileSpreadsheet className="size-4 text-muted" />}
        description="Tasks can write their rows into a Google Sheet after each run: replace the sheet, add new rows, or update rows by key. Scaper signs in with a Google Cloud service account you create; the key stays on this computer."
        footer={<Button icon={<Save className="size-4" />} loading={s.saving} onClick={() => void save()}>Save</Button>}>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>In Google Cloud, create a service account and turn on the Google Sheets API for its project.</li>
          <li>Create a JSON key for the account and paste it below.</li>
          <li>Share each spreadsheet with the account&apos;s email as an Editor.</li>
          <li>In a task, open Edit → Data → Google Sheets and paste the sheet&apos;s link.</li>
        </ol>
        {email ? <Callout tone="success" icon={<CheckCircle2 className="size-4 text-success" />} title="Service account saved">Share your sheets with <span className="inline-flex items-center gap-1"><Code>{email}</Code><CopyButton text={email} /></span></Callout> : null}
        <Field label={email ? "Replace the key" : "Service account key (JSON)"} hint="It is never sent back to the browser.">
          {(p) => <Textarea {...p} rows={4} className="font-mono text-xs" value={key} onChange={(e) => setKey(e.target.value)} placeholder='{"type": "service_account", "client_email": "…", "private_key": "…"}' />}
        </Field>
        {email && <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => void s.save({ googleServiceAccount: "" })}>Remove the key</Button>}
      </Panel>
      {email && (
        <Panel title="Test a sheet" icon={<Plug className="size-4 text-muted" />} description="Checks that the account can open the sheet and lists its tabs.">
          <div className="flex flex-wrap gap-2">
            <Input aria-label="Spreadsheet link" className="min-w-0 flex-1 font-mono text-xs" value={sheet} onChange={(e) => setSheet(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
            <Button variant="secondary" loading={testing} disabled={!sheet.trim()} onClick={() => void test()}>Test</Button>
          </div>
        </Panel>
      )}
      <Card>
        <CardHeader title="Tasks that sync" description={`${status.sheets.week.ok} syncs worked and ${status.sheets.week.failed} failed in the last 7 days.`} />
        {!status.sheets.tasks.length ? <p className="px-5 pb-5 text-sm text-muted">No task syncs to Sheets yet.</p> : (
          <ul className="divide-y divide-border">
            {status.sheets.tasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-sm">
                <Link prefetch={false} href={`/tasks/${t.id}`} className="font-medium hover:text-accent">{t.name}</Link>
                <Badge>{t.sheet}</Badge><Badge tone="accent">{t.mode}</Badge>
                <Link prefetch={false} href={`/tasks/${t.id}/edit?tab=data`} className="ml-auto text-xs text-accent hover:underline">Settings</Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const STATUS_TONE: Record<Delivery["status"], "success" | "warning" | "danger" | "neutral"> = { ok: "success", retrying: "warning", failed: "danger", pending: "neutral" };
const STATUS_TEXT: Record<Delivery["status"], string> = { ok: "Delivered", retrying: "Retrying", failed: "Failed", pending: "Pending" };

function DeliveriesTab() {
  const toast = useToast();
  const [kind, setKind] = useQueryState<"all" | "webhook" | "sheets">("kind", "all");
  const [status, setStatus] = useQueryState<"all" | "ok" | "retrying" | "failed">("status", "all");
  const [target] = useQueryState<string>("target", "");
  const path = `/api/deliveries?limit=100${kind !== "all" ? `&kind=${kind}` : ""}${status !== "all" ? `&status=${status}` : ""}${target ? `&target=${encodeURIComponent(target)}` : ""}`;
  const { data, error, loading, reload } = useApi<{ items: Delivery[]; nextCursor: string | null }>(path, { pollMs: 15_000 });
  const [open, setOpen] = useState<Delivery | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const redeliver = async (d: Delivery) => {
    setBusy(d.id);
    try { const r = await api<{ ok: boolean; delivery: Delivery }>(`/api/deliveries/${d.id}/redeliver`, { method: "POST" }); if (r.ok) toast.success("Delivered"); else toast.error("Still failing", r.delivery.error ?? `HTTP ${r.delivery.response_code}`); setOpen(r.delivery); void reload(); }
    catch (e) { toast.error("Could not redeliver", errorText(e)); } finally { setBusy(null); }
  };
  const retryFailed = async () => {
    setBusy("all");
    try { const r = await api<{ queued: number; sent: number }>("/api/deliveries/retry-failed", { method: "POST" }); toast.success(`${r.queued} failed deliveries retried`); void reload(); }
    catch (e) { toast.error("Could not retry", errorText(e)); } finally { setBusy(null); }
  };
  return (
    <Card>
      <CardHeader title="Delivery log" description="Every webhook and Sheets sync with its request, response and retries. Kept for 30 days."
        actions={<><Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} onClick={() => void reload()}>Refresh</Button><Button size="sm" variant="secondary" icon={<RotateCcw className="size-4" />} loading={busy === "all"} onClick={() => void retryFailed()}>Retry all failed</Button></>} />
      <div className="flex flex-wrap gap-3 px-5 pb-3">
        <FilterChips label="Kind" value={kind} onChange={setKind} options={[{ value: "all", label: "All" }, { value: "webhook", label: "Webhooks" }, { value: "sheets", label: "Sheets" }]} />
        <FilterChips label="Status" value={status} onChange={setStatus} options={[{ value: "all", label: "Any status" }, { value: "ok", label: "Delivered" }, { value: "retrying", label: "Retrying" }, { value: "failed", label: "Failed" }]} />
      </div>
      {error ? <div className="p-5"><ErrorNote message={error} onRetry={reload} /></div> : loading && !data ? <div className="p-5"><LoadingRows rows={5} /></div> : !data?.items.length ? (
        <EmptyState icon={<Send className="size-5" />} title="Nothing sent yet">Deliveries show up here when a webhook fires or a task syncs to a sheet.</EmptyState>
      ) : (
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-y border-border bg-surface-2/50 text-left text-xs text-muted">
              <tr><th className="px-5 py-2 font-medium">When</th><th className="px-3 py-2 font-medium">Event</th><th className="px-3 py-2 font-medium">Destination</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 text-right font-medium">Response</th><th className="px-3 py-2" /></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.items.map((d) => (
                <tr key={d.id} className="cursor-pointer hover:bg-surface-2/30" onClick={() => setOpen(d)}>
                  <td className="px-5 py-2.5 whitespace-nowrap text-muted" title={dateTime(d.created_at)}>{timeAgo(d.created_at)}</td>
                  <td className="px-3 py-2.5"><code className="font-mono text-xs">{d.event}</code></td>
                  <td className="max-w-[240px] px-3 py-2.5"><span className="flex items-center gap-1.5">{d.kind === "sheets" ? <FileSpreadsheet className="size-3.5 shrink-0 text-muted" /> : <Webhook className="size-3.5 shrink-0 text-muted" />}<span className="truncate">{d.target_name}</span></span></td>
                  <td className="px-3 py-2.5">
                    <Badge tone={STATUS_TONE[d.status]}>{d.status === "ok" ? <CheckCircle2 className="size-3" /> : d.status === "failed" ? <XCircle className="size-3" /> : <Clock className="size-3" />}{STATUS_TEXT[d.status]}</Badge>
                    {d.attempts > 1 && <span className="ml-1.5 text-xs text-muted">{d.attempts} tries</span>}
                    {d.status === "retrying" && d.next_attempt_at && <span className="block text-xs text-muted">next {timeAgo(d.next_attempt_at)}</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right text-xs tabular-nums text-muted">{d.response_code ? `HTTP ${d.response_code}` : "—"}{d.latency_ms !== null ? ` · ${d.latency_ms} ms` : ""}</td>
                  <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                    {d.kind === "webhook" && d.status !== "ok" && <Button size="sm" variant="ghost" loading={busy === d.id} onClick={() => void redeliver(d)}>Redeliver</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <Dialog open onClose={() => setOpen(null)} xl title={`${open.event} → ${open.target_name}`} description={`${STATUS_TEXT[open.status]} · ${dateTime(open.created_at)} · ${open.attempts} ${open.attempts === 1 ? "try" : "tries"}`}
          footer={<>{open.kind === "webhook" && <Button variant="secondary" icon={<RotateCcw className="size-4" />} loading={busy === open.id} onClick={() => void redeliver(open)}>Redeliver</Button>}<Button variant="secondary" onClick={() => setOpen(null)}>Close</Button></>}>
          <div className="space-y-4 text-sm">
            <p className="font-mono text-xs break-all text-muted">{open.kind === "webhook" ? "POST " : ""}{open.url}</p>
            {open.error && <Callout tone="danger" title="Error">{open.error}</Callout>}
            <div>
              <div className="mb-1 flex items-center justify-between"><p className="font-medium">Request body</p><CopyButton text={JSON.stringify(open.payload, null, 2)} /></div>
              <pre className="scroll-thin max-h-72 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">{JSON.stringify(open.payload, null, 2)}</pre>
            </div>
            <div>
              <p className="mb-1 font-medium">Response {open.response_code ? `(HTTP ${open.response_code}${open.latency_ms !== null ? `, ${open.latency_ms} ms` : ""})` : ""}</p>
              <pre className="scroll-thin max-h-48 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs whitespace-pre-wrap">{open.response_body || "—"}</pre>
            </div>
          </div>
        </Dialog>
      )}
    </Card>
  );
}

function Integrations() {
  const [tab, setTab] = useQueryState<Tab>("tab", "mcp");
  const settings = useApi<SettingsResponse>("/api/settings");
  const status = useApi<Status>("/api/integrations");
  const onSaved = () => { void status.reload(); void settings.reload(); };
  const err = settings.error ?? status.error;
  return (
    <>
      <PageHeader title="Integrations" description="Connect Scaper to the rest of your tools: AI apps over MCP, webhooks with signed payloads and retries, and Google Sheets." />
      <Tabs value={tab} onChange={setTab} className="mb-6" tabs={[
        { value: "mcp", label: "MCP", icon: <Bot className="size-4" /> },
        { value: "webhooks", label: "Webhooks", icon: <Webhook className="size-4" />, count: status.data ? status.data.webhooks.endpoints || null : null },
        { value: "sheets", label: "Google Sheets", icon: <FileSpreadsheet className="size-4" /> },
        { value: "deliveries", label: "Delivery log", icon: <Send className="size-4" />, count: status.data?.webhooks.week.failed || null },
      ]} />
      {err ? <ErrorNote message={err} onRetry={onSaved} /> : tab === "deliveries" ? <DeliveriesTab /> : !settings.data || !status.data ? <Card><LoadingRows rows={6} /></Card> : (
        <>
          {tab === "mcp" && <McpTab data={settings.data} status={status.data} onSaved={onSaved} />}
          {tab === "webhooks" && <WebhooksTab data={settings.data} status={status.data} onSaved={onSaved} />}
          {tab === "sheets" && <SheetsTab data={settings.data} status={status.data} onSaved={onSaved} />}
        </>
      )}
      <p className="mt-6 flex items-center gap-1.5 text-xs text-muted"><KeyRound className="size-3.5" />Secrets, keys and webhook URLs are stored only in your local database and come back to the browser hidden.</p>
    </>
  );
}

export default function Page() {
  return <Suspense><Integrations /></Suspense>;
}
