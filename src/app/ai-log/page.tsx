"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BrainCircuit, Trash2 } from "lucide-react";
import { ConfirmDialog, Dialog } from "@/components/dialog";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, EmptyState, ErrorNote, FilterChips, KeyValue, LoadingRows, PageHeader, SearchInput, Select, Stat } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { dateTime, duration, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";

type Call = {
  id: string; created_at: string; purpose: string; ref_id: string | null; provider_id: string | null; provider_name: string | null; model: string;
  status: "ok" | "error" | "cached"; tokens_in: number; tokens_out: number; cost: number; latency_ms: number; attempts: number;
  fallback_from: string | null; error: string | null; has_request: boolean;
};
type FullCall = Omit<Call, "has_request"> & { request: string | null; response: string | null };
type Stats = {
  days: number; totals: { calls: number; tokens_in: number; tokens_out: number; cost: number; errors: number; cached: number; avg_ms: number; fallbacks: number };
  byPurpose: { purpose: string; calls: number; cost: number; tokens: number }[];
};
type Page = { items: Call[]; nextCursor: string | null; stats?: Stats };
type Status = "all" | "ok" | "error" | "cached";

const PURPOSES: Record<string, string> = {
  agent: "Agent", extract: "AI extraction", fields: "Field suggestions", columns: "AI columns", selectors: "Selector suggestions", plan: "Category planning",
  heal: "Fix with AI", watcher: "Watcher triage", deals: "Deal ranking", test: "Tests", chat: "Other", briefing: "Briefings", rules: "Data check suggestions",
  team: "Helper agents", review: "Self-review",
  "decide:scrape-check": "Decision: OK to scrape?", "decide:links": "Decision: which links", "decide:agent-guard": "Decision: agent guardrail", "decide:playground": "Decision playground", "decide:test": "Decision test",
};
const money = (v: number) => (v >= 1 ? `$${v.toFixed(2)}` : v > 0 ? `$${v.toFixed(4)}` : "$0");
const tokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("en-IN"));

/** Shows a logged prompt as a readable conversation instead of raw JSON. */
function Transcript({ request, response }: { request: string | null; response: string | null }) {
  const req = useMemo(() => { try { return request ? JSON.parse(request) as { messages: { role: string; content: string | null; tool_calls?: unknown[]; name?: string }[]; tools?: string[]; json?: boolean } : null; } catch { return null; } }, [request]);
  const res = useMemo(() => {
    if (!response) return null;
    try { const r = JSON.parse(response) as { content?: string; tool_calls?: { function: { name: string; arguments: string } }[]; truncated?: boolean }; return typeof r === "object" && r ? r : { content: response }; }
    catch { return { content: response }; }
  }, [response]);
  if (!request && !response) return <p className="text-sm text-muted">The prompt was not kept, because &quot;Keep prompts and replies&quot; was off in Settings → AI.</p>;
  return (
    <div className="space-y-3">
      {req?.tools?.length ? <p className="text-xs text-muted">Tools offered: {req.tools.join(", ")}</p> : null}
      {req?.json && <p className="text-xs text-muted">JSON reply requested</p>}
      {(req?.messages ?? []).map((m, i) => (
        <div key={i} className={cn("rounded-lg border border-border p-3", m.role === "system" && "bg-surface-2/60", m.role === "assistant" && "border-accent/30")}>
          <p className="mb-1 text-xs font-medium text-muted">{m.role}{m.name ? ` · ${m.name}` : ""}</p>
          {m.content && <pre className="max-h-72 overflow-auto font-mono text-xs whitespace-pre-wrap break-words">{m.content}</pre>}
          {m.tool_calls?.length ? <pre className="mt-1 font-mono text-xs text-accent whitespace-pre-wrap">{JSON.stringify(m.tool_calls, null, 1)}</pre> : null}
        </div>
      ))}
      {res && (
        <div className="rounded-lg border border-success/40 p-3">
          <p className="mb-1 text-xs font-medium text-success">reply{res.truncated ? " (cut off at the token limit)" : ""}</p>
          {res.content && <pre className="max-h-72 overflow-auto font-mono text-xs whitespace-pre-wrap break-words">{res.content}</pre>}
          {res.tool_calls?.map((t, i) => <p key={i} className="font-mono text-xs text-accent">→ {t.function.name}({t.function.arguments})</p>)}
        </div>
      )}
    </div>
  );
}

function CallDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error, loading } = useApi<{ call: FullCall }>(`/api/ai/calls/${id}`);
  const c = data?.call;
  return (
    <Dialog open onClose={onClose} xl title={c ? `${PURPOSES[c.purpose] ?? c.purpose} · ${c.model}` : "AI call"} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {error ? <ErrorNote message={error} /> : loading || !c ? <LoadingRows rows={4} /> : (
        <div className="space-y-4">
          <KeyValue items={[
            { label: "When", value: dateTime(c.created_at) },
            { label: "Provider", value: c.provider_name ?? "–" },
            { label: "Status", value: <Badge tone={c.status === "error" ? "danger" : c.status === "cached" ? "accent" : "success"}>{c.status}</Badge> },
            { label: "Tokens", value: `${c.tokens_in.toLocaleString("en-IN")} in · ${c.tokens_out.toLocaleString("en-IN")} out` },
            { label: "Cost", value: money(c.cost) },
            { label: "Time", value: `${duration(c.latency_ms)}${c.attempts > 1 ? ` · ${c.attempts} attempts` : ""}` },
            { label: "Fell back from", value: c.fallback_from ?? "", hidden: !c.fallback_from },
            { label: "Error", value: <span className="text-danger">{c.error}</span>, hidden: !c.error },
            { label: "Part of", value: c.purpose === "agent" && c.ref_id ? <Link prefetch={false} className="text-accent hover:underline" href={`/agent?run=${c.ref_id}`}>agent conversation</Link> : c.ref_id ?? "", hidden: !c.ref_id },
          ]} />
          <Transcript request={c.request} response={c.response} />
        </div>
      )}
    </Dialog>
  );
}

function AiLogPage() {
  const toast = useToast();
  const [status, setStatus] = useQueryState<Status>("status", "all");
  const [purpose, setPurpose] = useQueryState<string>("purpose", "");
  const [open, setOpen] = useQueryState<string>("call", "");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [extra, setExtra] = useState<Call[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [more, setMore] = useState(false);
  const [clearing, setClearing] = useState<"" | "old" | "all">("");

  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const qs = useMemo(() => {
    const p = new URLSearchParams({ limit: "100" });
    if (status !== "all") p.set("status", status);
    if (purpose) p.set("purpose", purpose);
    if (debounced) p.set("q", debounced);
    return p.toString();
  }, [status, purpose, debounced]);
  const { data, error, loading, reload } = useApi<Page>(`/api/ai/calls?${qs}&stats=30`, { pollMs: 15_000 });
  const [lastQs, setLastQs] = useState(qs);
  if (lastQs !== qs) { setLastQs(qs); setExtra([]); setCursor(undefined); }

  const calls = [...(data?.items ?? []), ...extra];
  const next = cursor === undefined ? data?.nextCursor : cursor;
  const loadMore = async () => {
    if (!next) return;
    setMore(true);
    try { const page = await api<Page>(`/api/ai/calls?${qs}&before=${encodeURIComponent(next)}`); setExtra((e) => [...e, ...page.items]); setCursor(page.nextCursor); }
    catch (e) { toast.error("Could not load more", errorText(e)); } finally { setMore(false); }
  };
  const clear = async () => {
    try {
      const r = await api<{ removed: number }>(`/api/ai/calls${clearing === "old" ? "?olderThanDays=7" : ""}`, { method: "DELETE" });
      toast.success(`Deleted ${r.removed} entries`); setClearing(""); setExtra([]); setCursor(undefined); void reload();
    } catch (e) { toast.error("Could not delete", errorText(e)); }
  };
  const t = data?.stats?.totals;

  return (
    <>
      <PageHeader title="AI log" description="Every call Scaper made to your models: what it was for, which model answered, tokens, cost and time. Private work is never logged."
        actions={<>
          <Button variant="secondary" icon={<Trash2 className="size-4" />} onClick={() => setClearing("old")}>Delete older than 7 days</Button>
          <Button variant="ghost" onClick={() => setClearing("all")}>Delete all</Button>
        </>} />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Calls (30 days)" value={t ? t.calls.toLocaleString("en-IN") : "–"} hint={t?.cached ? `${t.cached} reused from cache` : undefined} />
        <Stat label="Tokens" value={t ? tokens(t.tokens_in + t.tokens_out) : "–"} hint={t ? `${tokens(t.tokens_in)} in · ${tokens(t.tokens_out)} out` : undefined} />
        <Stat label="Cost" value={t ? money(t.cost) : "–"} hint="From the prices on your models" />
        <Stat label="Average time" value={t?.avg_ms ? duration(Math.round(t.avg_ms)) : "–"} />
        <Stat label="Errors" value={t ? t.errors : "–"} hint={t?.fallbacks ? `${t.fallbacks} saved by a fallback` : undefined} />
      </div>
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <FilterChips label="Status" value={status} onChange={setStatus} options={[{ value: "all", label: "All" }, { value: "ok", label: "Answered" }, { value: "cached", label: "Cached" }, { value: "error", label: "Failed" }]} />
            <Select aria-label="What for" className="w-48" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              <option value="">Everything</option>
              {(data?.stats?.byPurpose ?? []).map((p) => <option key={p.purpose} value={p.purpose}>{PURPOSES[p.purpose] ?? p.purpose} ({p.calls})</option>)}
            </Select>
          </div>
          <SearchInput value={q} onChange={setQ} placeholder="Search model, error or prompt" className="w-full lg:w-72" />
        </div>
        {error ? <div className="p-4"><ErrorNote message={error} onRetry={reload} /></div> : loading && !data ? <LoadingRows rows={8} /> : !calls.length ? (
          <EmptyState icon={<BrainCircuit className="size-5" />} title="No AI calls">
            {status !== "all" || purpose || debounced ? "Nothing matches these filters." : <>Calls appear here when the agent, AI extraction or category scraping use your model. <Link prefetch={false} href="/settings?tab=ai" className="text-accent hover:underline">Set up a provider</Link></>}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-surface-2/60 text-left text-xs text-muted">
                <tr><th className="px-4 py-2.5 font-medium">When</th><th className="px-3 py-2.5 font-medium">For</th><th className="px-3 py-2.5 font-medium">Model</th><th className="px-3 py-2.5 font-medium">Status</th><th className="px-3 py-2.5 text-right font-medium">Tokens</th><th className="px-3 py-2.5 text-right font-medium">Cost</th><th className="px-4 py-2.5 text-right font-medium">Time</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {calls.map((c) => (
                  <tr key={c.id} className={cn("cursor-pointer hover:bg-surface-2/50", c.status === "error" && "bg-danger-soft/30")} onClick={() => setOpen(c.id)}>
                    <td className="px-4 py-2 whitespace-nowrap text-muted" title={dateTime(c.created_at)}>{timeAgo(c.created_at)}</td>
                    <td className="px-3 py-2"><button type="button" className="text-left hover:underline" onClick={(e) => { e.stopPropagation(); setOpen(c.id); }}>{PURPOSES[c.purpose] ?? c.purpose}</button></td>
                    <td className="px-3 py-2"><span className="font-mono text-xs">{c.model}</span>{c.provider_name && <span className="text-xs text-muted"> · {c.provider_name}</span>}{c.fallback_from && <Badge className="ml-1.5" tone="warning">fallback</Badge>}</td>
                    <td className="px-3 py-2">{c.status === "error" ? <span className="text-danger" title={c.error ?? ""}>{(c.error ?? "failed").slice(0, 60)}</span> : <Badge tone={c.status === "cached" ? "accent" : "success"}>{c.status === "cached" ? "cached" : "ok"}</Badge>}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{c.tokens_in + c.tokens_out ? tokens(c.tokens_in + c.tokens_out) : "–"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{c.cost ? money(c.cost) : "–"}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted">{c.latency_ms ? duration(c.latency_ms) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {next && <div className="border-t border-border p-3 text-center"><Button variant="ghost" loading={more} onClick={loadMore}>Load older</Button></div>}
      </Card>
      {open && <CallDialog id={open} onClose={() => setOpen("")} />}
      <ConfirmDialog open={Boolean(clearing)} onCancel={() => setClearing("")} onConfirm={() => void clear()}
        title={clearing === "all" ? "Delete the whole AI log?" : "Delete AI log entries older than 7 days?"} body="Usage totals for your daily limit and budget are kept." />
    </>
  );
}

export default function Page() {
  return <Suspense><AiLogPage /></Suspense>;
}
