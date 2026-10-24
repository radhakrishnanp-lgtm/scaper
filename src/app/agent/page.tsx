"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BadgePercent, BookOpen, Bot, GraduationCap, EyeOff, CornerDownRight, ListChecks, MessageSquarePlus, Radar, Search, Send, ShieldCheck, Trash2, Wrench } from "lucide-react";
import type { AgentRun } from "@/server/repo/agent";
import { PlaybooksDialog, TeamPanel, type TeamData } from "@/components/agent-team";
import { KnowledgeDialog, ReviewCard } from "@/components/agent-knowledge";
import { TOOL_LABEL, Turn } from "@/components/agent-run";
import type { Review } from "@/server/repo/knowledge";
import { ConfirmDialog } from "@/components/dialog";
import { useToast } from "@/components/toast";
import { Badge, Button, Callout, Card, CardHeader, EmptyState, ErrorNote, IconButton, Kbd, PageHeader, SearchInput, Select, Switch, Textarea } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";

const EXAMPLES: { group: string; icon: React.ReactNode; items: string[] }[] = [
  { group: "Scrape", icon: <Search className="size-4" />, items: [
    "Open https://news.ycombinator.com and list the top 10 stories with their points and links.",
    "Work out selectors for the name, price and link of each product on https://books.toscrape.com and extract the first page.",
  ] },
  { group: "Deals", icon: <BadgePercent className="size-4" />, items: [
    "Find the 10 highest-discount wireless earbuds on https://www.amazon.in/s?k=wireless+earbuds with at least 4 stars, and tell me which discounts look real.",
    "Compare my tracked products and tell me which one is the best buy today, using their price history.",
  ] },
  { group: "Watch", icon: <Radar className="size-4" />, items: [
    "Watch https://example.com/careers and alert me when a job with \"Backend\" in the title appears. Check every 3 hours.",
    "What changed on my watched pages in the last 24 hours? Summarise the important changes.",
  ] },
  { group: "Tasks", icon: <ListChecks className="size-4" />, items: [
    "List my saved tasks and tell me which ones are failing.",
    "Run my task with \"jobs\" in its name and summarise the new rows.",
  ] },
];

type Catalog = { tools: { name: string; group: string; changes: boolean; description: string }[]; approval: "ask" | "auto"; maxSteps: number; privateMode: boolean };
type ProviderModels = { id: string; name: string; enabled: boolean; models: { id: string }[] };
type AiPublic = { main: { providerId: string; model: string }; fast: { providerId: string; model: string }; providers: ProviderModels[] };
type Detail = { run: AgentRun; thread: AgentRun[]; team: TeamData | null; review: Review | null };

function Composer({ value, onChange, onSubmit, busy, disabled, followUp, model, setModel, ai, priv, setPriv, privLocked }: {
  value: string; onChange: (v: string) => void; onSubmit: () => void; busy: boolean; disabled: boolean; followUp: boolean;
  model: string; setModel: (v: string) => void; ai?: AiPublic; priv: boolean; setPriv: (v: boolean) => void; privLocked: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, [followUp]);
  const name = (r?: { providerId: string; model: string }) => (r?.model ? `${r.model}${ai?.providers.find((p) => p.id === r.providerId)?.name ? ` · ${ai.providers.find((p) => p.id === r.providerId)!.name}` : ""}` : "");
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }} className="space-y-3 p-4">
      <Textarea ref={ref} aria-label={followUp ? "Follow-up question" : "Task for the agent"} value={value} onChange={(e) => onChange(e.target.value)} className="min-h-24"
        placeholder={followUp ? "Ask a follow-up, e.g. “Now track the top 3 and alert me below ₹2,000”" : "Find the best real deals on 55-inch TVs on Amazon India…"}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !disabled) { e.preventDefault(); onSubmit(); } }} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <Select aria-label="Model" className="h-9 w-72 max-w-full" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="main">Main model{ai?.main.model ? `: ${name(ai.main)}` : ""}</option>
            <option value="fast">Fast model{ai?.fast.model ? `: ${name(ai.fast)}` : " (same as main)"}</option>
            {ai?.providers.filter((p) => p.enabled && p.models.length).map((p) => (
              <optgroup key={p.id} label={p.name}>{p.models.map((m) => <option key={m.id} value={`${p.id}::${m.id}`}>{m.id}</option>)}</optgroup>
            ))}
          </Select>
          <Switch checked={priv || privLocked} disabled={privLocked} onChange={setPriv} label="Private" description={privLocked ? "On for everything in Settings → Privacy" : "Kept in memory only, never saved"} />
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted sm:inline"><Kbd>Ctrl</Kbd> <Kbd>Enter</Kbd></span>
          <Button type="submit" loading={busy} disabled={disabled} icon={<Send className="size-4" />}>{followUp ? "Ask" : "Run"}</Button>
        </div>
      </div>
    </form>
  );
}

function AgentPage() {
  const toast = useToast();
  const [selected, setSelected] = useQueryState<string>("run", "");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const history = useApi<{ runs: AgentRun[] }>(`/api/agent/runs?limit=50${debounced ? `&q=${encodeURIComponent(debounced)}` : ""}`);
  const settings = useApi<{ settings: { ai: AiPublic } }>("/api/settings");
  const catalog = useApi<Catalog>("/api/agent");
  const [running, setRunning] = useState(false);
  const detail = useApi<Detail>(selected ? `/api/agent/runs/${selected}` : null, { pollMs: running ? 1200 : undefined });
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("main");
  const [priv, setPriv] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [del, setDel] = useState<AgentRun | null>(null);
  const [playbooks, setPlaybooks] = useState(false);
  const [knowledge, setKnowledge] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const ai = settings.data?.settings.ai;
  const configured = Boolean(ai && ((ai.main.providerId && ai.main.model) || (ai.fast.providerId && ai.fast.model)));
  const privLocked = Boolean(catalog.data?.privateMode);
  const run = detail.data?.run.id === selected ? detail.data.run : null;
  const isRunning = run?.status === "running";
  if (isRunning !== running) setRunning(isRunning);
  const { reload: reloadHistory } = history;
  const { reload: reloadDetail } = detail;
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    if (!run) return;
    if (lastStatus.current === "running" && run.status !== "running") {
      void reloadHistory();
      // The self-review runs just after the answer; pick it up when it lands.
      if (!run.private) for (const ms of [3000, 8000, 20000]) setTimeout(() => void reloadDetail(), ms);
    }
    lastStatus.current = run.status;
  }, [run, reloadHistory, reloadDetail]);
  const stepCount = run?.steps.length ?? 0;
  useEffect(() => { if (isRunning) bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [stepCount, isRunning]);

  const start = async () => {
    if (prompt.trim().length < 3 || !configured) return;
    setStarting(true);
    try {
      const r = await api<{ run: AgentRun }>("/api/agent", { body: { prompt, model, private: priv || privLocked || run?.private || undefined, followUpOf: run && run.status !== "running" ? run.id : undefined } });
      setPrompt("");
      setSelected(r.run.id);
      void history.reload();
    } catch (e) { toast.error("The agent could not start", errorText(e)); } finally { setStarting(false); }
  };
  const stop = async () => {
    if (!run) return;
    setStopping(true);
    try { await api(`/api/agent/runs/${run.id}/stop`, { method: "POST" }); void detail.reload(); toast.info("Stopping", "It finishes the step it is on, then stops."); }
    catch (e) { toast.error("Could not stop", errorText(e)); } finally { setStopping(false); }
  };
  const remove = async (r: AgentRun) => {
    try {
      await api(`/api/agent/runs/${r.id}`, { method: "DELETE" });
      toast.success("Deleted");
      if (selected === r.id) setSelected("");
      setDel(null);
      void history.reload();
    } catch (e) { toast.error("Could not delete", errorText(e)); }
  };

  const today = useMemo(() => {
    const day = new Date().toDateString();
    const runs = (history.data?.runs ?? []).filter((r) => new Date(r.created_at).toDateString() === day);
    return { runs: runs.length, tokens: runs.reduce((a, r) => a + r.tokens_in + r.tokens_out, 0) };
  }, [history.data]);

  return (
    <>
      <PageHeader title="Agent" description="Ask in plain words. It scrapes, compares prices, tracks products and sets up watchers with your own AI model, and shows every step it takes."
        actions={<div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<GraduationCap className="size-4" />} onClick={() => setKnowledge(true)}>Knowledge</Button>
          <Button variant="secondary" icon={<BookOpen className="size-4" />} onClick={() => setPlaybooks(true)}>Playbooks</Button>
          {selected && <Button variant="secondary" icon={<MessageSquarePlus className="size-4" />} onClick={() => { setSelected(""); setPrompt(""); }}>New conversation</Button>}
        </div>} />
      {settings.data && !configured && (
        <div className="mb-6"><Callout tone="warning" title="Connect a model first" action={<Link prefetch={false} href="/settings?tab=ai"><Button size="sm">Open AI settings</Button></Link>}>Any OpenAI-compatible endpoint works: OpenAI, OpenRouter, Groq, Together, DeepSeek, or Ollama and LM Studio on this computer. The model must support tool calling.</Callout></div>
      )}
      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-6">
          {!selected ? (
            <>
              <Card>
                <Composer value={prompt} onChange={setPrompt} onSubmit={start} busy={starting} disabled={!configured || prompt.trim().length < 3} followUp={false} model={model} setModel={setModel} ai={ai} priv={priv} setPriv={setPriv} privLocked={privLocked} />
              </Card>
              <div className="grid gap-4 md:grid-cols-2">
                {EXAMPLES.map((g) => (
                  <Card key={g.group}>
                    <div className="space-y-2 p-4">
                      <p className="flex items-center gap-2 text-sm font-semibold"><span className="text-accent">{g.icon}</span>{g.group}</p>
                      {g.items.map((ex) => (
                        <button type="button" key={ex} onClick={() => setPrompt(ex)} className="block w-full rounded-lg border border-border px-3 py-2 text-left text-xs text-muted hover:border-accent hover:text-text">{ex}</button>
                      ))}
                    </div>
                  </Card>
                ))}
              </div>
              <Card>
                <CardHeader title="What it can do" description={catalog.data ? (catalog.data.approval === "ask"
                  ? `Up to ${catalog.data.maxSteps} steps per question. Anything marked “asks first” waits for your OK.`
                  : `Up to ${catalog.data.maxSteps} steps per question. Approvals are off in Settings → AI, so changes happen without asking.`) : undefined} />
                {catalog.data ? (
                  <div className="grid gap-5 p-5 md:grid-cols-2">
                    {[...new Set(catalog.data.tools.map((t) => t.group))].map((g) => (
                      <div key={g}>
                        <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">{g}</p>
                        <ul className="space-y-1 text-sm">
                          {catalog.data!.tools.filter((t) => t.group === g).map((t) => (
                            <li key={t.name} className="flex items-start gap-2" title={t.description}>
                              <Wrench className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
                              <span><span className="font-medium">{TOOL_LABEL[t.name] ?? t.name}</span>{t.changes && <Badge tone="warning" className="ml-1.5">{catalog.data!.approval === "ask" ? "asks first" : "changes things"}</Badge>}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : <div className="p-5"><div className="skeleton h-24 rounded-lg" /></div>}
              </Card>
              <Callout icon={<ShieldCheck className="size-4 text-accent" />} title="Safety">Page content is passed to the model as data, and instructions found on pages are ignored. It never runs code the model writes, never types passwords and stops at bot checks and logins. Every run counts towards your daily AI limit in Settings.</Callout>
            </>
          ) : detail.error && !run ? (
            <ErrorNote message={detail.error} onRetry={detail.reload} />
          ) : !run ? (
            <Card><div className="space-y-3 p-5"><div className="skeleton h-10 rounded-lg" /><div className="skeleton h-24 rounded-lg" /></div></Card>
          ) : (
            <Card>
              <CardHeader title={detail.data!.thread.length ? `Conversation · ${detail.data!.thread.length + 1} turns` : "Conversation"}
                actions={<IconButton label="Delete this turn" onClick={() => setDel(run)}><Trash2 className="size-4" /></IconButton>} />
              <div className="space-y-8 p-5">
                {detail.data!.thread.map((t) => (
                  <div key={t.id} className="opacity-90"><Turn run={t} compact /></div>
                ))}
                <Turn run={run} onStop={stop} stopping={stopping} onAnswered={() => void detail.reload()} />
                {detail.data!.team && <TeamPanel team={detail.data!.team} runId={run.id} onChanged={() => void detail.reload()} />}
                {detail.data!.review && <ReviewCard review={detail.data!.review} />}
                <div ref={bottom} />
              </div>
              <div className="border-t border-border">
                {isRunning ? (
                  <p className="p-4 text-sm text-muted">You can ask a follow-up once this answer is finished.</p>
                ) : (
                  <Composer value={prompt} onChange={setPrompt} onSubmit={start} busy={starting} disabled={!configured || prompt.trim().length < 3} followUp model={model} setModel={setModel} ai={ai} priv={priv} setPriv={setPriv} privLocked={privLocked} />
                )}
              </div>
            </Card>
          )}
        </div>

        <Card className="h-fit xl:sticky xl:top-20">
          <CardHeader title="History" description={history.data ? `${today.runs} run${today.runs === 1 ? "" : "s"} today · ${today.tokens.toLocaleString("en-IN")} tokens` : undefined} />
          <div className="border-b border-border p-3"><SearchInput value={q} onChange={setQ} placeholder="Search questions" className="w-full" /></div>
          {history.error ? <div className="p-4"><ErrorNote message={history.error} onRetry={history.reload} /></div> : !history.data ? (
            <div className="space-y-2 p-4"><div className="skeleton h-12 rounded-lg" /><div className="skeleton h-12 rounded-lg" /></div>
          ) : !history.data.runs.length ? (
            <EmptyState icon={<Bot className="size-5" />} title={debounced ? "No matches" : "No runs yet"}>{debounced ? "Try other words." : "Your questions and answers are kept here."}</EmptyState>
          ) : (
            <ul className="scroll-thin max-h-[70vh] divide-y divide-border overflow-y-auto">
              {history.data.runs.map((r) => (
                <li key={r.id} className={cn("group relative", selected === r.id && "bg-accent-soft/40")}>
                  <button type="button" onClick={() => setSelected(r.id)} className="w-full px-4 py-3 pr-10 text-left hover:bg-surface-2/50">
                    <p className="line-clamp-2 text-sm">{r.parent_id && <CornerDownRight className="mr-1 inline size-3.5 text-muted" aria-label="Follow-up" />}{r.prompt}</p>
                    <p className="mt-1 flex items-center gap-2 text-xs text-muted">
                      {r.private && <Badge><EyeOff className="size-3" />private</Badge>}
                      {r.pending && <Badge tone="warning">waiting for you</Badge>}
                      <Badge tone={r.status === "done" ? "success" : r.status === "error" ? (r.error === "Stopped by you." ? "neutral" : "danger") : "accent"}>{r.status === "error" && r.error === "Stopped by you." ? "stopped" : r.status}</Badge>
                      {timeAgo(r.created_at)}
                    </p>
                  </button>
                  <button type="button" aria-label="Delete" onClick={() => setDel(r)} className="absolute top-3 right-3 rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100"><Trash2 className="size-3.5" /></button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {playbooks && <PlaybooksDialog onClose={() => setPlaybooks(false)} />}
      {knowledge && <KnowledgeDialog onClose={() => setKnowledge(false)} />}
      <ConfirmDialog open={Boolean(del)} onCancel={() => setDel(null)} onConfirm={() => del && void remove(del)} confirmLabel="Delete" title="Delete this question and answer?"
        body={del?.status === "running" ? "It is still working; it will be stopped first." : "Follow-up questions after it are kept."} />
    </>
  );
}

export default function Page() {
  return <Suspense><AgentPage /></Suspense>;
}
