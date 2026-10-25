"use client";

import { Suspense, use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, Brain, ChevronLeft, Eraser, GraduationCap, MessageSquare, Pause, Pencil, Play, Plus, Send, Settings2, ThumbsDown, ThumbsUp, Trash2, Wand2 } from "lucide-react";
import type { AgentRun } from "@/server/repo/agent";
import type { BotEval, BotMemory } from "@/server/repo/bots";
import { ApprovalCard, Turn } from "@/components/agent-run";
import { BotEditor, BotStatus, EVENT_LABEL, PERMISSIONS, type BotView, type Targets } from "@/components/bot-editor";
import { ConfirmDialog } from "@/components/dialog";
import { CHANNELS } from "@/components/form-bits";
import { useLiveEvents } from "@/components/live";
import { useToast } from "@/components/toast";
import { Badge, Button, Callout, Card, EmptyState, ErrorNote, Field, IconButton, Input, KeyValue, LoadingRows, PageHeader, Tabs, Textarea } from "@/components/ui";
import { api, ClientApiError, errorText } from "@/lib/api-client";
import { dateTime, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";

type Detail = { bot: BotView; runs: AgentRun[]; memory: BotMemory[]; evals: BotEval[] };
type View = "activity" | "chat" | "memory" | "setup";

const triggerLabel = (t?: string | null) => {
  if (!t) return "Run";
  if (t === "schedule") return "Scheduled run";
  if (t === "manual") return "You ran it";
  if (t === "chat") return "Chat";
  if (t.startsWith("event:")) return `Woken: ${EVENT_LABEL[t.slice(6) as keyof typeof EVENT_LABEL]?.toLowerCase() ?? t.slice(6)}`;
  return t;
};

const SCORE_TONE = (n: number) => (n >= 4 ? "success" : n === 3 ? "warning" : "danger") as "success" | "warning" | "danger";

/** The bot's own grade of a run, and your 👍/👎 with a note, which it keeps as a lesson. */
function Grade({ bot, run, e, onChanged }: { bot: BotView; run: AgentRun; e?: BotEval; onChanged: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const rating = e?.user_rating ?? 0;
  const send = async (r: -1 | 0 | 1, n: string) => {
    setBusy(String(r));
    try {
      await api(`/api/bots/${bot.id}/runs/${run.id}/feedback`, { body: { rating: r, note: n } });
      toast.success(n.trim() ? `${bot.name} will remember that` : "Thanks", n.trim() ? "It follows your note from its next run on." : undefined);
      setNote(null); onChanged();
    } catch (err) { toast.error("Could not save", errorText(err)); } finally { setBusy(null); }
  };
  const apply = async () => {
    if (!e?.suggestion) return;
    setBusy("apply");
    try {
      const instructions = [bot.instructions.trim(), e.suggestion.trim()].filter(Boolean).join("\n");
      await api(`/api/bots/${bot.id}`, { method: "PUT", body: { instructions: instructions.slice(0, 4000) } });
      toast.success("Added to its instructions", e.suggestion); onChanged();
    } catch (err) { toast.error("Could not change the instructions", errorText(err)); } finally { setBusy(null); }
  };
  if (run.status === "running") return null;
  const applied = Boolean(e?.suggestion && bot.instructions.includes(e.suggestion.trim()));
  return (
    <div className="space-y-2 rounded-xl border border-border bg-surface-2/40 p-3 text-sm">
      {e?.score ? (
        <>
          <p className="flex flex-wrap items-center gap-2">
            <GraduationCap className="size-4 text-muted" aria-hidden />
            <Badge tone={SCORE_TONE(e.score)}>{e.score}/5</Badge>
            <span className="text-xs text-muted">{e.met_job ? "did its job" : "did not finish its job"}</span>
            <span className="min-w-0 flex-1">{e.summary}</span>
          </p>
          {e.lessons.length > 0 && <ul className="list-disc space-y-0.5 pl-9 text-xs text-muted">{e.lessons.map((l) => <li key={l}>Learned: {l}</li>)}</ul>}
          {e.suggestion && (
            <p className="flex flex-wrap items-center gap-2 text-xs"><span className="text-muted">Suggests adding to its instructions:</span> <span className="min-w-0 flex-1">“{e.suggestion}”</span>
              {applied ? <Badge tone="success">added</Badge> : <Button size="sm" variant="ghost" icon={<Wand2 className="size-4" />} loading={busy === "apply"} onClick={() => void apply()}>Apply</Button>}
            </p>
          )}
        </>
      ) : bot.selfEval ? <p className="text-xs text-muted">Grading this run…</p> : null}
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs text-muted">Was this run right?</span>
        <IconButton size="sm" label="Good run" aria-pressed={rating > 0} className={rating > 0 ? "bg-success/15 text-success" : ""} disabled={busy !== null} onClick={() => void send(rating > 0 ? 0 : 1, e?.user_note ?? "")}><ThumbsUp className="size-4" /></IconButton>
        <IconButton size="sm" label="Bad run" aria-pressed={rating < 0} className={rating < 0 ? "bg-danger/15 text-danger" : ""} disabled={busy !== null} onClick={() => { if (rating < 0) void send(0, e?.user_note ?? ""); else setNote(e?.user_note ?? ""); }}><ThumbsDown className="size-4" /></IconButton>
        {note === null && <Button size="sm" variant="ghost" onClick={() => setNote(e?.user_note ?? "")}>{e?.user_note ? "Edit note" : "Add a note"}</Button>}
        {e?.user_note && note === null && <span className="min-w-0 flex-1 truncate text-xs text-muted" title={e.user_note}>“{e.user_note}”</span>}
      </div>
      {note !== null && (
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(ev) => { ev.preventDefault(); void send(rating === 0 && note.trim() ? -1 : rating, note); }}>
          <Input aria-label="What should it do differently?" className="min-w-0 flex-1" autoFocus value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="What should it do differently? e.g. “Skip sponsored videos”" />
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={busy !== null}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setNote(null)}>Cancel</Button>
          </div>
        </form>
      )}
    </div>
  );
}

function Activity_({ bot, runs, evals, onChanged }: { bot: BotView; runs: AgentRun[]; evals: BotEval[]; onChanged: () => void }) {
  const list = runs.filter((r) => r.trigger !== "chat");
  if (!list.length) return <EmptyState icon={<Activity className="size-5" />} title="No runs yet">Run it now, or wait for its schedule or events. Each run&apos;s steps and report show up here.</EmptyState>;
  const byRun = new Map(evals.map((e) => [e.run_id, e]));
  const graded = evals.filter((e) => e.score);
  const avg = graded.length ? graded.reduce((s, e) => s + (e.score ?? 0), 0) / graded.length : null;
  return (
    <ul className="space-y-4">
      {avg !== null && <li className="text-sm text-muted">Average grade over its last {graded.length} graded runs: <strong className="text-text">{avg.toFixed(1)}/5</strong>. Your 👍/👎 and notes teach it what you want.</li>}
      {list.map((r, i) => (
        <li key={r.id}>
          <Card className="space-y-3 p-4">
            <p className="flex flex-wrap items-center gap-2 text-sm"><Badge>{triggerLabel(r.trigger)}</Badge><time className="text-muted" title={dateTime(r.created_at)}>{timeAgo(r.created_at)}</time></p>
            <Turn run={r} compact={i > 0} hidePrompt avatar={<span aria-hidden>{bot.emoji}</span>} who={bot.name} />
            <Grade bot={bot} run={r} e={byRun.get(r.id)} onChanged={onChanged} />
          </Card>
        </li>
      ))}
    </ul>
  );
}

function Chat({ bot, runs, onChanged }: { bot: BotView; runs: AgentRun[]; onChanged: () => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const chats = runs.filter((r) => r.trigger === "chat").reverse();
  const last = chats.at(-1);
  const running = Boolean(last && last.status === "running");
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [chats.length]);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try { await api(`/api/bots/${bot.id}/run`, { body: { prompt: text, followUpOf: last?.id } }); setText(""); onChanged(); }
    catch (e) { toast.error("Could not send", errorText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      {chats.length === 0 && <p className="text-sm text-muted">Talk to {bot.name} here: ask it to do its job differently, tell it your preferences to remember, or give it a one-off job. It uses its own memory and permissions.</p>}
      <div className="space-y-6">{chats.map((r) => <Turn key={r.id} run={r} avatar={<span aria-hidden>{bot.emoji}</span>} who={bot.name} />)}</div>
      <div ref={end} />
      <Card>
        <form className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <Textarea aria-label={`Message ${bot.name}`} value={text} onChange={(e) => setText(e.target.value)} className="min-h-20" placeholder={`Message ${bot.name}, e.g. “Only tell me about drops below ₹2,000 from now on”`}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
          <div className="flex justify-end"><Button type="submit" icon={<Send className="size-4" />} loading={busy} disabled={running || !text.trim()}>{running ? "Working…" : "Send"}</Button></div>
        </form>
      </Card>
    </div>
  );
}

function Memory({ bot, memory, onChanged }: { bot: BotView; memory: BotMemory[]; onChanged: () => void }) {
  const toast = useToast();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [clearing, setClearing] = useState(false);
  const facts = memory.filter((m) => m.kind === "fact");
  const runs = memory.filter((m) => m.kind === "run");
  const lessons = memory.filter((m) => m.kind === "lesson");
  const add = async () => {
    setErrors({});
    try { await api(`/api/bots/${bot.id}/memory`, { body: { key, value } }); setKey(""); setValue(""); onChanged(); }
    catch (e) { if (e instanceof ClientApiError && e.fields) setErrors(e.fields); toast.error("Could not save", errorText(e)); }
  };
  const forget = async (m: BotMemory) => {
    try { await api(`/api/bots/${bot.id}/memory/${m.id}`, { method: "DELETE" }); onChanged(); } catch (e) { toast.error("Could not forget it", errorText(e)); }
  };
  const clear = async () => {
    try { await api(`/api/bots/${bot.id}/memory`, { method: "DELETE" }); toast.success("Memory cleared"); setClearing(false); onChanged(); } catch (e) { toast.error("Could not clear", errorText(e)); }
  };
  return (
    <div className="space-y-6">
      {!bot.memory && <Callout tone="warning" title="Memory is off for this bot">It starts fresh each run. Turn it on in Edit → more options.</Callout>}
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">What {bot.name} remembers <span className="text-sm font-normal text-muted">({facts.length})</span></h3>
          {memory.length > 0 && <Button size="sm" variant="ghost" icon={<Eraser className="size-4" />} onClick={() => setClearing(true)}>Clear all</Button>}
        </div>
        {facts.length ? (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {facts.map((m) => (
              <li key={m.id} className="flex items-start gap-3 px-3 py-2 text-sm">
                <span className="w-40 shrink-0 font-mono text-xs break-all text-muted">{m.key}</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap">{m.value}</span>
                <span className="shrink-0 text-xs text-muted">{timeAgo(m.updated_at)}</span>
                <IconButton size="sm" label={`Forget ${m.key}`} onClick={() => void forget(m)}><Trash2 className="size-4" /></IconButton>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted">Nothing yet. The bot saves facts it needs next time, like the last price it saw or what it already told you.</p>}
        <form className="mt-4 grid gap-3 md:grid-cols-[200px_1fr_auto] md:items-end" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <Field label="Name" error={errors.key}>{(f) => <Input {...f} value={key} onChange={(e) => setKey(e.target.value)} placeholder="budget" />}</Field>
          <Field label="Fact" error={errors.value}>{(f) => <Input {...f} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Under ₹30,000, no refurbished" />}</Field>
          <Button type="submit" variant="secondary" icon={<Plus className="size-4" />} disabled={!key.trim() || !value.trim()}>Add</Button>
        </form>
      </Card>
      <Card className="p-4">
        <h3 className="mb-1 font-semibold">Lessons <span className="text-sm font-normal text-muted">({lessons.length})</span></h3>
        <p className="mb-3 text-xs text-muted">{bot.selfEval ? "Rules it taught itself by grading its runs, and the notes you left on runs. It reads them at the start of every run." : "Self-grading is off (Edit → more options), so only your notes on runs end up here."}</p>
        {lessons.length ? (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {lessons.map((m) => (
              <li key={m.id} className="flex items-start gap-3 px-3 py-2 text-sm">
                <Badge tone={m.key.startsWith("user:") ? "accent" : "neutral"}>{m.key.startsWith("user:") ? "you" : "self"}</Badge>
                <span className="min-w-0 flex-1">{m.value}</span>
                <span className="shrink-0 text-xs text-muted">{timeAgo(m.updated_at)}</span>
                <IconButton size="sm" label="Forget this lesson" onClick={() => void forget(m)}><Trash2 className="size-4" /></IconButton>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted">None yet. Leave a 👎 and a note on a run in Activity, and it will follow it.</p>}
      </Card>
      <Card className="p-4">
        <h3 className="mb-3 font-semibold">Recent runs it remembers</h3>
        {runs.length ? <ul className="space-y-2 text-sm">{runs.map((m) => <li key={m.id} className="flex gap-3"><time className="w-24 shrink-0 text-xs text-muted" title={dateTime(m.updated_at)}>{timeAgo(m.updated_at)}</time><span className="min-w-0 flex-1">{m.value}</span></li>)}</ul>
          : <p className="text-sm text-muted">A one-line summary of each run appears here and goes into the bot&apos;s next run.</p>}
      </Card>
      <ConfirmDialog open={clearing} onCancel={() => setClearing(false)} onConfirm={() => void clear()} confirmLabel="Clear memory" title={`Clear ${bot.name}'s memory?`} body="It forgets every fact and run summary and starts fresh." />
    </div>
  );
}

function Setup({ bot }: { bot: BotView }) {
  const perm = PERMISSIONS.find((p) => p.value === bot.permission)!;
  const channels = CHANNELS.filter((c) => bot.notify[c.key]).map((c) => c.label);
  return (
    <Card className="space-y-4 p-4">
      <div><p className="text-sm font-medium">Its job</p><p className="mt-1 text-sm whitespace-pre-wrap text-muted">{bot.task}</p></div>
      {bot.instructions && <div><p className="text-sm font-medium">Instructions</p><p className="mt-1 text-sm whitespace-pre-wrap text-muted">{bot.instructions}</p></div>}
      <KeyValue items={[
        { label: "Runs", value: bot.scheduleText },
        { label: "Wakes on", value: bot.triggers.length ? bot.triggers.map((t) => EVENT_LABEL[t.event]).join(", ") : "No events" },
        { label: "May do", value: `${perm.label}: ${perm.help}` },
        { label: "Tells you on", value: bot.notifyMode === "off" ? "Nothing (its page only)" : `${channels.join(", ") || "Inbox"} · ${bot.notifyMode === "always" ? "after every run" : "when it finds something"}` },
        { label: "Only when", value: bot.condition, hidden: !bot.condition },
        { label: "Stops when", value: bot.stopWhen, hidden: !bot.stopWhen },
        { label: "Model", value: `${bot.model === "main" ? "Main" : "Fast"} model, up to ${bot.maxSteps} steps${bot.helpers ? ", may start helpers" : ""}` },
        { label: "Memory", value: bot.memory ? "On" : "Off" },
        { label: "Event cooldown", value: `${bot.cooldownMinutes} min` },
      ]} />
    </Card>
  );
}

function BotPage({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const [running, setRunning] = useState(false);
  // A running bot updates step by step; poll while it works.
  const detail = useApi<Detail>(`/api/bots/${id}`, { pollMs: running ? 2000 : 0 });
  const targets = useApi<{ targets: Targets }>("/api/bots");
  const [view, setView] = useQueryState<View>("tab", "activity");
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const d = detail.data;
  const isRunning = Boolean(d?.runs.some((r) => r.status === "running"));
  if (isRunning !== running) setRunning(isRunning);
  useLiveEvents((e) => { if ((e.type === "bot" && e.id === id) || (e.type === "agent" && d?.runs.some((r) => r.id === e.id))) void detail.reload(); });

  if (detail.error) return <ErrorNote message={detail.error} onRetry={detail.reload} />;
  if (!d) return <LoadingRows rows={4} />;
  const bot = d.bot;
  const pending = d.runs.filter((r) => r.status === "running" && r.pending);

  const run = async () => {
    setBusy("run");
    try { await api(`/api/bots/${bot.id}/run`, { body: {} }); toast.success(`${bot.name} is running`); setView("activity"); void detail.reload(); }
    catch (e) { toast.error("Could not start the bot", errorText(e)); } finally { setBusy(null); }
  };
  const toggle = async () => {
    setBusy("toggle");
    try { await api(`/api/bots/${bot.id}`, { method: "PUT", body: { enabled: !bot.enabled } }); toast.success(bot.enabled ? `${bot.name} is paused` : `${bot.name} is on`); void detail.reload(); }
    catch (e) { toast.error("Could not change it", errorText(e)); } finally { setBusy(null); }
  };
  const remove = async () => {
    try { await api(`/api/bots/${bot.id}`, { method: "DELETE" }); toast.success(`${bot.name} deleted`); router.push("/bots"); }
    catch (e) { toast.error("Could not delete", errorText(e)); }
  };

  return (
    <div>
      <Link href="/bots" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-text"><ChevronLeft className="size-4" />All bots</Link>
      <PageHeader title={`${bot.emoji} ${bot.name}`} description={bot.role}
        actions={<>
          <BotStatus bot={bot} />
          <Button icon={<Play className="size-4" />} loading={busy === "run"} disabled={running} onClick={() => void run()}>Run now</Button>
          <Button variant="secondary" icon={bot.enabled ? <Pause className="size-4" /> : <Play className="size-4" />} loading={busy === "toggle"} onClick={() => void toggle()}>{bot.enabled ? "Pause" : "Turn on"}</Button>
          <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>
          <IconButton label={`Delete ${bot.name}`} onClick={() => setDeleting(true)}><Trash2 className="size-4" /></IconButton>
        </>} />
      <p className="-mt-3 mb-4 text-xs text-muted">
        {bot.scheduleText}{bot.triggers.length ? ` · wakes on ${bot.triggers.length} event${bot.triggers.length === 1 ? "" : "s"}` : ""}
        {bot.enabled && bot.next_run_at && <> · next run <time title={dateTime(bot.next_run_at)}>{timeAgo(bot.next_run_at)}</time></>}
        {bot.finished_reason && <> · finished: {bot.finished_reason}</>}
      </p>
      {pending.map((r) => <div key={r.id} className="mb-4"><ApprovalCard run={r} who={bot.name} onAnswered={() => void detail.reload()} /></div>)}
      <Tabs className="mb-4" value={view} onChange={setView} tabs={[
        { value: "activity", label: "Activity", icon: <Activity className="size-4" />, count: d.runs.filter((r) => r.trigger !== "chat").length },
        { value: "chat", label: "Chat", icon: <MessageSquare className="size-4" /> },
        { value: "memory", label: "Memory", icon: <Brain className="size-4" />, count: d.memory.filter((m) => m.kind === "fact").length },
        { value: "setup", label: "Setup", icon: <Settings2 className="size-4" /> },
      ]} />
      {view === "activity" && <Activity_ bot={bot} runs={d.runs} evals={d.evals} onChanged={() => void detail.reload()} />}
      {view === "chat" && <Chat bot={bot} runs={d.runs} onChanged={() => void detail.reload()} />}
      {view === "memory" && <Memory bot={bot} memory={d.memory} onChanged={() => void detail.reload()} />}
      {view === "setup" && <Setup bot={bot} />}
      {editing && <BotEditor bot={bot} targets={targets.data?.targets ?? null} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void detail.reload(); }} />}
      <ConfirmDialog open={deleting} onCancel={() => setDeleting(false)} onConfirm={() => void remove()} title={`Delete ${bot.name}?`} body="Its memory is deleted too. Its past runs stay in the history." />
    </div>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Suspense><BotPage id={id} /></Suspense>;
}
