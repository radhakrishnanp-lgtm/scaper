"use client";

import { Fragment, Suspense, useMemo, useState } from "react";
import { ChevronDown, Cookie, Globe, MoreHorizontal, Pause, Pencil, Plus, RotateCcw, ShieldCheck, Trash2, X } from "lucide-react";
import type { HostSummary } from "@/server/repo/sites";
import { BarChart } from "@/components/charts";
import { ConfirmDialog, Dialog } from "@/components/dialog";
import { Menu } from "@/components/menu";
import { useToast } from "@/components/toast";
import { Badge, Button, Callout, Card, EmptyState, ErrorNote, Field, FilterChips, IconButton, Input, LoadingRows, PageHeader, SearchInput, Select, Switch, Textarea } from "@/components/ui";
import { api, ClientApiError, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { bytes, lastDays, shortDay, timeAgo } from "@/lib/format";
import type { FetchMode } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";

type Rule = {
  host: string; delay_seconds: number | null; mode: FetchMode | null; user_agent: string; headers: { name: string; value: string }[]; cookies: string; hasCookies: boolean;
  respect_robots: boolean | null; paused: boolean; notes: string; updated_at: string;
};
type Site = { host: string; stats: HostSummary | null; rule: Rule | null; backoff: { penalty: number; blockedForMs: number } | null };
type Filter = "all" | "rules" | "trouble";

type RuleDraft = { host: string; delaySeconds: string; mode: "" | FetchMode; userAgent: string; headers: { name: string; value: string }[]; cookies: string; respectRobots: "" | "yes" | "no"; paused: boolean; notes: string };
const toDraft = (host: string, r: Rule | null): RuleDraft => ({
  host, delaySeconds: r?.delay_seconds?.toString() ?? "", mode: r?.mode ?? "", userAgent: r?.user_agent ?? "", headers: r?.headers ?? [], cookies: r?.cookies ?? "",
  respectRobots: r?.respect_robots === null || r?.respect_robots === undefined ? "" : r.respect_robots ? "yes" : "no", paused: r?.paused ?? false, notes: r?.notes ?? "",
});

function Daily({ host }: { host: string }) {
  const { data, loading } = useApi<{ daily: { day: string; ok: number; blocked: number; errors: number }[] }>(`/api/sites/${encodeURIComponent(host)}`);
  if (loading || !data) return <div className="skeleton h-32 rounded-lg" />;
  const by = new Map(data.daily.map((d) => [d.day, d]));
  const rows = lastDays(30).map((day) => ({ label: shortDay(day), values: { ok: by.get(day)?.ok ?? 0, blocked: by.get(day)?.blocked ?? 0, errors: by.get(day)?.errors ?? 0 } }));
  return <BarChart label={`Requests per day to ${host}`} height={130} data={rows} emptyText="No requests in the last 30 days."
    series={[{ key: "ok", label: "OK", color: "var(--accent)" }, { key: "blocked", label: "Blocked", color: "var(--warning)" }, { key: "errors", label: "Errors", color: "var(--danger)" }]} />;
}

function RuleDialog({ draft, onClose, onSaved, isNew }: { draft: RuleDraft; onClose: () => void; onSaved: () => void; isNew: boolean }) {
  const toast = useToast();
  const [d, setD] = useState(draft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErrors({});
    try {
      await api("/api/sites", { body: {
        host: d.host.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""), delaySeconds: d.delaySeconds ? Number(d.delaySeconds) : null, mode: d.mode || null,
        userAgent: d.userAgent, headers: d.headers.filter((h) => h.name.trim()), cookies: d.cookies, respectRobots: d.respectRobots === "" ? null : d.respectRobots === "yes", paused: d.paused, notes: d.notes,
      } });
      toast.success("Site rule saved", d.host);
      onSaved(); onClose();
    } catch (e) {
      if (e instanceof ClientApiError && e.fields) setErrors(e.fields);
      toast.error("Could not save", errorText(e));
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} wide title={isNew ? "New site rule" : `Rule for ${d.host}`} description="Applies to this host and its subdomains. The most specific rule wins."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy}>Save rule</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Host" error={errors.host}>{(p) => <Input {...p} value={d.host} disabled={!isNew} onChange={(e) => setD({ ...d, host: e.target.value })} placeholder="www.example.com" />}</Field>
          <Field label="Wait between requests (seconds)" hint="Empty = the default from Settings. Can only be slower than the default." error={errors.delaySeconds}>{(p) => <Input {...p} type="number" min={1} max={600} value={d.delaySeconds} onChange={(e) => setD({ ...d, delaySeconds: e.target.value })} placeholder="Default" />}</Field>
          <Field label="Load pages with">{(p) => <Select {...p} value={d.mode} onChange={(e) => setD({ ...d, mode: e.target.value as RuleDraft["mode"] })}><option value="">What each task or watcher says</option><option value="fast">Always Fast</option><option value="browser">Always Browser</option></Select>}</Field>
          <Field label="robots.txt">{(p) => <Select {...p} value={d.respectRobots} onChange={(e) => setD({ ...d, respectRobots: e.target.value as RuleDraft["respectRobots"] })}><option value="">Default from Settings</option><option value="yes">Respect it</option><option value="no">Ignore it (only for sites you own or may crawl)</option></Select>}</Field>
        </div>
        <Field label="User agent" hint="Empty = Scaper's honest default, which names the tool. Use this to add your contact details, not to pretend to be someone else.">{(p) => <Input {...p} value={d.userAgent} onChange={(e) => setD({ ...d, userAgent: e.target.value })} placeholder="Scaper (personal use; me@example.com)" />}</Field>
        <div>
          <p className="mb-1.5 text-sm font-medium">Extra headers</p>
          <div className="space-y-2">
            {d.headers.map((h, i) => (
              <div key={i} className="flex gap-2">
                <Input aria-label="Header name" className="w-48 font-mono text-xs" value={h.name} onChange={(e) => setD({ ...d, headers: d.headers.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)) })} placeholder="Accept-Language" />
                <Input aria-label="Header value" className="font-mono text-xs" value={h.value} onChange={(e) => setD({ ...d, headers: d.headers.map((x, k) => (k === i ? { ...x, value: e.target.value } : x)) })} placeholder="en-IN" />
                <IconButton size="sm" label="Remove header" onClick={() => setD({ ...d, headers: d.headers.filter((_, k) => k !== i) })}><X className="size-4" /></IconButton>
              </div>
            ))}
            {d.headers.length < 20 && <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setD({ ...d, headers: [...d.headers, { name: "", value: "" }] })}>Add header</Button>}
          </div>
          {errors["headers.0.name"] && <p className="mt-1 text-xs text-danger">{errors["headers.0.name"]}</p>}
        </div>
        <Field label="Cookies" hint={d.cookies.endsWith("set") ? "Saved cookies are kept as they are. Paste new ones to replace them, or clear the box to remove them." : "For your own logged-in account on this site, copied from your browser (name=value; name2=value2). Sent only to this host, stored only in your local database."}>
          {(p) => <Textarea {...p} rows={2} className="font-mono text-xs" value={d.cookies} onChange={(e) => setD({ ...d, cookies: e.target.value })} placeholder="session=…; prefs=…" />}
        </Field>
        <Field label="Notes">{(p) => <Input {...p} value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} placeholder="Why this rule exists" />}</Field>
        <Switch label="Pause this site" description="Every task, watcher and price check skips it until you un-pause." checked={d.paused} onChange={(v) => setD({ ...d, paused: v })} />
      </div>
    </Dialog>
  );
}

function SitesPage() {
  const toast = useToast();
  const { data, error, loading, reload } = useApi<{ sites: Site[] }>("/api/sites");
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ draft: RuleDraft; isNew: boolean } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const sites = useMemo(() => data?.sites ?? [], [data]);
  const trouble = (s: Site) => Boolean(s.backoff?.blockedForMs || (s.stats && (s.stats.blocked > 0 || s.stats.errors / Math.max(1, s.stats.requests) > 0.2)) || s.rule?.paused);
  const shown = sites.filter((s) => (filter === "rules" ? Boolean(s.rule) : filter === "trouble" ? trouble(s) : true) && (!q.trim() || s.host.includes(q.trim().toLowerCase())));

  const reset = async (host: string) => {
    try { const r = await api<{ ok: boolean }>(`/api/sites/${encodeURIComponent(host)}/reset`, { method: "POST" }); toast.success(r.ok ? "Backoff cleared" : "Nothing to clear", host); void reload(); }
    catch (e) { toast.error("Could not reset", errorText(e)); }
  };
  const remove = async (host: string) => {
    try { await api(`/api/sites/${encodeURIComponent(host)}`, { method: "DELETE" }); toast.success("Rule removed", host); setConfirm(null); void reload(); }
    catch (e) { toast.error("Could not remove", errorText(e)); }
  };

  return (
    <>
      <PageHeader title="Sites" description="Every site Scaper visits: how it responds, and your rules for it." actions={<Button icon={<Plus className="size-4" />} onClick={() => setEdit({ draft: toDraft("", null), isNew: true })}>Add site rule</Button>} />
      <div className="mb-6">
        <Callout icon={<ShieldCheck className="size-4 text-accent" />} title="Polite by design">
          Scaper waits between requests to each site, follows robots.txt by default, and slows down on its own when a site answers with errors or a robot check. It never solves CAPTCHAs, rotates proxies or disguises its browser. Rules here let you slow down further, pause a site, or send your own cookies for your own account.
        </Callout>
      </div>
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <FilterChips label="Show" value={filter} onChange={setFilter} options={[
            { value: "all", label: "All", count: sites.length }, { value: "rules", label: "With rules", count: sites.filter((s) => s.rule).length },
            { value: "trouble", label: "Needs attention", count: sites.filter(trouble).length },
          ]} />
          <SearchInput value={q} onChange={setQ} placeholder="Search hosts" className="w-full lg:w-60" />
        </div>
        {error ? <div className="p-4"><ErrorNote message={error} onRetry={reload} /></div> : loading && !data ? <LoadingRows /> : !shown.length ? (
          <EmptyState icon={<Globe className="size-5" />} title={sites.length ? "No sites match" : "No sites yet"}>{sites.length ? "Try another filter." : "Sites appear here after the first scrape, check or price update."}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-2/60 text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Site</th>
                  <th className="px-3 py-2.5 text-right font-medium">Requests · 30d</th>
                  <th className="hidden px-3 py-2.5 font-medium md:table-cell">Success</th>
                  <th className="hidden px-3 py-2.5 text-right font-medium lg:table-cell">Avg time</th>
                  <th className="hidden px-3 py-2.5 text-right font-medium lg:table-cell">Data</th>
                  <th className="px-3 py-2.5 font-medium">State</th>
                  <th className="px-3 py-2.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shown.map((s) => {
                  const st = s.stats;
                  const okPct = st && st.requests ? Math.round((st.ok / st.requests) * 100) : null;
                  const backing = s.backoff && s.backoff.blockedForMs > 0;
                  return (
                    <Fragment key={s.host}>
                      <tr className="hover:bg-surface-2/40">
                        <td className="px-4 py-3">
                          <button type="button" className="flex items-center gap-2 text-left font-medium hover:text-accent" onClick={() => setOpen(open === s.host ? null : s.host)} aria-expanded={open === s.host}>
                            <ChevronDown className={cn("size-4 text-muted transition-transform", open === s.host && "rotate-180")} />{s.host}
                          </button>
                          {s.rule && (
                            <div className="mt-1 flex flex-wrap gap-1 pl-6">
                              {s.rule.delay_seconds && <Badge>{s.rule.delay_seconds}s delay</Badge>}
                              {s.rule.mode && <Badge>{s.rule.mode}</Badge>}
                              {s.rule.hasCookies && <Badge tone="accent"><Cookie className="size-3" />cookies</Badge>}
                              {s.rule.headers.length > 0 && <Badge>{s.rule.headers.length} header{s.rule.headers.length === 1 ? "" : "s"}</Badge>}
                              {s.rule.user_agent && <Badge>own UA</Badge>}
                              {s.rule.respect_robots === false && <Badge tone="warning">robots off</Badge>}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">{st?.requests.toLocaleString("en-IN") ?? "—"}</td>
                        <td className="hidden px-3 py-3 md:table-cell">
                          {okPct === null ? "—" : (
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2"><div className={cn("h-full rounded-full", okPct >= 90 ? "bg-success" : okPct >= 60 ? "bg-warning" : "bg-danger")} style={{ width: `${okPct}%` }} /></div>
                              <span className="text-xs tabular-nums">{okPct}%</span>
                              {st!.blocked > 0 && <span className="text-xs text-warning">{st!.blocked} blocked</span>}
                            </div>
                          )}
                        </td>
                        <td className="hidden px-3 py-3 text-right text-muted tabular-nums lg:table-cell">{st ? `${st.avg_ms} ms` : "—"}</td>
                        <td className="hidden px-3 py-3 text-right text-muted tabular-nums lg:table-cell">{st ? bytes(st.bytes) : "—"}</td>
                        <td className="px-3 py-3">
                          {s.rule?.paused ? <Badge tone="warning"><Pause className="size-3" />paused by you</Badge>
                            : backing ? <Badge tone="warning">slowing down · {Math.ceil(s.backoff!.blockedForMs / 60_000)} min</Badge>
                              : st?.last_status && st.last_status >= 400 ? <Badge tone="danger">HTTP {st.last_status}</Badge>
                                : <Badge tone="success">ok</Badge>}
                          {st?.last_at && <p className="mt-0.5 text-xs text-muted">{timeAgo(st.last_at)}</p>}
                        </td>
                        <td className="px-3 py-3 text-right">
                          <Menu label={`Actions for ${s.host}`} trigger={(p) => <IconButton {...p} size="sm" label="More actions"><MoreHorizontal className="size-4" /></IconButton>} items={[
                            { label: s.rule ? "Edit rule" : "Add rule", icon: <Pencil />, onSelect: () => setEdit({ draft: toDraft(s.host, s.rule), isNew: !s.rule }) },
                            ...(s.backoff && (s.backoff.blockedForMs > 0 || s.backoff.penalty > 0) ? [{ label: "Clear slow-down", icon: <RotateCcw />, hint: "after checking it yourself", onSelect: () => void reset(s.host) }] : []),
                            { label: "Open site", href: `https://${s.host}`, external: true },
                            ...(s.rule ? [{ separator: true as const }, { label: "Remove rule", icon: <Trash2 />, danger: true, onSelect: () => setConfirm(s.host) }] : []),
                          ]} />
                        </td>
                      </tr>
                      {open === s.host && (
                        <tr><td colSpan={7} className="bg-surface-2/30 px-4 py-4">
                          <Daily host={s.host} />
                          {s.rule?.notes && <p className="mt-3 text-sm text-muted">Note: {s.rule.notes}</p>}
                        </td></tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {edit && <RuleDialog draft={edit.draft} isNew={edit.isNew} onClose={() => setEdit(null)} onSaved={() => void reload()} />}
      <ConfirmDialog open={Boolean(confirm)} onCancel={() => setConfirm(null)} onConfirm={() => confirm && void remove(confirm)} title={`Remove the rule for ${confirm}?`} confirmLabel="Remove" body="The site goes back to your default settings. Saved cookies for it are deleted." />
    </>
  );
}

export default function Page() {
  return <Suspense><SitesPage /></Suspense>;
}
