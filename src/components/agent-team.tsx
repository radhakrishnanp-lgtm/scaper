"use client";

import { useState } from "react";
import { BookOpen, Brain, CheckCircle2, CircleDot, Pencil, Plus, Square, Trash2, Users, XCircle } from "lucide-react";
import type { MemoryEntry, Playbook, Worker } from "@/server/repo/team";
import { ConfirmDialog, Dialog } from "@/components/dialog";
import { Markdown } from "@/components/markdown";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, Field, IconButton, Input, Textarea } from "@/components/ui";
import { api, ClientApiError, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";

export type TeamData = { workers: Worker[]; memory: MemoryEntry[] };

const money = (v: number) => (v >= 0.01 ? `$${v.toFixed(2)}` : v > 0 ? `$${v.toFixed(4)}` : "$0");
const STATUS: Record<Worker["status"], { label: string; tone: "accent" | "success" | "danger" | "neutral"; icon: React.ReactNode }> = {
  running: { label: "working", tone: "accent", icon: <CircleDot className="size-3 animate-pulse" /> },
  done: { label: "reported", tone: "success", icon: <CheckCircle2 className="size-3" /> },
  error: { label: "failed", tone: "danger", icon: <XCircle className="size-3" /> },
  stopped: { label: "stopped", tone: "neutral", icon: <Square className="size-3" /> },
};

function HelperCard({ w, runId, onChanged }: { w: Worker; runId: string; onChanged: () => void }) {
  const toast = useToast();
  const [stopping, setStopping] = useState(false);
  const tools = w.steps.filter((s) => s.type === "tool");
  const last = w.steps.at(-1);
  const s = STATUS[w.status];
  const stop = async () => {
    setStopping(true);
    try { await api(`/api/agent/runs/${runId}/helpers/${w.id}/stop`, { method: "POST" }); onChanged(); }
    catch (e) { toast.error("Could not stop it", errorText(e)); } finally { setStopping(false); }
  };
  return (
    <li className="rounded-xl border border-border">
      <div className="flex flex-wrap items-start gap-3 p-3">
        <span className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold", w.status === "running" ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted")}>{w.name.slice(0, 2).toUpperCase()}</span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{w.name}<Badge tone={s.tone}>{s.icon}{s.label}</Badge><Badge>{w.model} model</Badge>{w.playbook_id && <Badge><BookOpen className="size-3" />playbook</Badge>}</p>
          {w.role && <p className="text-xs text-muted">{w.role}</p>}
          <p className="mt-1 text-xs text-muted">{tools.length} step{tools.length === 1 ? "" : "s"} · {(w.tokens_in + w.tokens_out).toLocaleString("en-IN")} tokens · {money(w.cost)} · {timeAgo(w.updated_at)}
            {w.status === "running" && last && <> · now: {last.type === "tool" ? last.name : last.type === "message" ? "reading your message" : "thinking"}</>}</p>
        </div>
        {w.status === "running" && <Button size="sm" variant="secondary" icon={<Square className="size-3.5" />} loading={stopping} onClick={() => void stop()}>Stop</Button>}
      </div>
      <details className="border-t border-border px-3 py-2 text-sm">
        <summary className="cursor-pointer text-xs text-muted">Instructions the supervisor wrote, steps and report</summary>
        <div className="mt-2 space-y-3">
          <div><p className="text-xs font-medium">Task</p><p className="text-xs whitespace-pre-wrap">{w.task}</p></div>
          <div><p className="text-xs font-medium">Instructions (its system prompt)</p><pre className="scroll-thin max-h-48 overflow-auto rounded-lg bg-surface-2 p-2 text-xs whitespace-pre-wrap">{w.instructions}</pre></div>
          {w.examples && <div><p className="text-xs font-medium">Examples</p><pre className="scroll-thin max-h-32 overflow-auto rounded-lg bg-surface-2 p-2 text-xs whitespace-pre-wrap">{w.examples}</pre></div>}
          {w.questions && <div><p className="text-xs font-medium">Decision questions</p><pre className="scroll-thin max-h-40 overflow-auto rounded-lg bg-surface-2 p-2 font-mono text-xs">{JSON.stringify(w.questions, null, 2)}</pre></div>}
          {w.steps.length > 0 && (
            <ol className="space-y-1 text-xs">
              {w.steps.map((st, i) => (
                <li key={i} className="flex gap-2">
                  {st.type === "tool" ? <>{st.ok ? <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-success" aria-label="ok" /> : <XCircle className="mt-0.5 size-3 shrink-0 text-danger" aria-label="failed" />}<span className="font-mono">{st.name}</span><span className="truncate text-muted">{JSON.stringify(st.args).slice(0, 120)}</span></>
                    : st.type === "message" ? <span className="text-accent">Supervisor: {st.text}</span> : <span className="text-muted italic">{st.text.slice(0, 300)}</span>}
                </li>
              ))}
            </ol>
          )}
          <p className="text-xs text-muted">Tools: {w.tools.length} read-only{w.tools.length < 12 ? ` (${w.tools.join(", ")})` : ""}, plus shared memory and decide.</p>
        </div>
      </details>
      {(w.result || w.error) && (
        <div className="border-t border-border p-3">
          {w.error && <p className="text-sm text-danger">{w.error}</p>}
          {w.result && <div className="max-h-72 overflow-auto text-sm"><Markdown text={w.result} /></div>}
        </div>
      )}
    </li>
  );
}

/** The supervisor's helpers and their shared memory, under the conversation. */
export function TeamPanel({ team, runId, onChanged }: { team: TeamData; runId: string; onChanged: () => void }) {
  const running = team.workers.filter((w) => w.status === "running").length;
  const cost = team.workers.reduce((a, w) => a + w.cost, 0);
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Users className="size-4 text-muted" />Team: {team.workers.length} helper{team.workers.length === 1 ? "" : "s"}</span>}
        description={`${running ? `${running} working now · ` : ""}${team.memory.length} shared note${team.memory.length === 1 ? "" : "s"} · helpers cost ${money(cost)}. The supervisor wrote each helper's instructions and reads their reports.`} />
      <div className="space-y-5 p-5">
        {team.workers.length > 0 && <ul className="space-y-3">{team.workers.map((w) => <HelperCard key={w.id} w={w} runId={runId} onChanged={onChanged} />)}</ul>}
        <div>
          <p className="mb-2 flex items-center gap-2 text-sm font-medium"><Brain className="size-4 text-muted" />Shared memory</p>
          {!team.memory.length ? <p className="text-sm text-muted">Nothing shared yet.</p> : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {team.memory.map((m) => (
                <li key={m.id} className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
                  <div className="min-w-0"><p className="truncate font-mono text-xs">{m.key}</p><p className="text-xs text-muted">{m.author} · {timeAgo(m.created_at)}</p></div>
                  <p className="text-xs break-words whitespace-pre-wrap">{m.value}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Playbooks

type Draft = { name: string; kind: string; instructions: string; examples: string; questions: string; notes: string };
const emptyDraft: Draft = { name: "", kind: "", instructions: "", examples: "", questions: "", notes: "" };

function PlaybookEditor({ initial, onClose, onSaved }: { initial: Playbook | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<Draft>(initial ? { name: initial.name, kind: initial.kind, instructions: initial.instructions, examples: initial.examples, questions: initial.questions ? JSON.stringify(initial.questions, null, 2) : "", notes: initial.notes } : emptyDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    let questions: unknown = null;
    if (d.questions.trim()) {
      try { questions = JSON.parse(d.questions); } catch { setErrors({ questions: "This is not valid JSON." }); return; }
    }
    setBusy(true); setErrors({});
    try {
      await api(initial ? `/api/playbooks/${initial.id}` : "/api/playbooks", { method: initial ? "PUT" : "POST", body: { ...d, questions } });
      toast.success(initial ? "Saved as a new version" : "Playbook added");
      onSaved();
    } catch (e) {
      if (e instanceof ClientApiError && e.fields) setErrors(Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k.split(".")[0]!, v])));
      toast.error("Could not save", errorText(e));
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} xl title={initial ? `Edit ${initial.name}` : "New playbook"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => void save()}>Save</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={errors.name}>{(f) => <Input {...f} disabled={Boolean(initial)} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="shop price reader" />}</Field>
          <Field label="Kind of job">{(f) => <Input {...f} value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value })} placeholder="price comparison" />}</Field>
        </div>
        <Field label="Helper instructions" hint="Becomes the helper's system prompt, after Scaper's own rules." error={errors.instructions}>{(f) => <Textarea {...f} rows={8} value={d.instructions} onChange={(e) => setD({ ...d, instructions: e.target.value })} />}</Field>
        <Field label="Examples of good output">{(f) => <Textarea {...f} rows={4} value={d.examples} onChange={(e) => setD({ ...d, examples: e.target.value })} />}</Field>
        <Field label="Decision questions (JSON, optional)" hint={'{"in_stock": {"type": "noul", "instructions": "Is the item in stock?"}}'} error={errors.questions}>{(f) => <Textarea {...f} rows={5} className="font-mono text-xs" value={d.questions} onChange={(e) => setD({ ...d, questions: e.target.value })} spellCheck={false} />}</Field>
        <Field label="Notes">{(f) => <Textarea {...f} rows={3} value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} />}</Field>
      </div>
    </Dialog>
  );
}

export function PlaybooksDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const list = useApi<{ playbooks: Playbook[] }>("/api/playbooks");
  const [editing, setEditing] = useState<Playbook | "new" | null>(null);
  const [deleting, setDeleting] = useState<Playbook | null>(null);
  const remove = async (p: Playbook) => {
    try { await api(`/api/playbooks/${p.id}`, { method: "DELETE" }); toast.success("Deleted"); setDeleting(null); void list.reload(); }
    catch (e) { toast.error("Could not delete", errorText(e)); }
  };
  return (
    <>
      <Dialog open={!editing && !deleting} onClose={onClose} xl title="Playbooks"
        footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>New playbook</Button></>}>
        <p className="mb-4 text-sm text-muted">Instructions, examples and decision questions for helper agents. The supervisor looks here before it writes new ones, saves what worked, and rates each one after use, so the best rise to the top. You can edit them too.</p>
        {list.error ? <ErrorNote message={list.error} onRetry={list.reload} /> : !list.data ? <div className="skeleton h-32 rounded-lg" /> : !list.data.playbooks.length ? (
          <EmptyState icon={<BookOpen className="size-5" />} title="No playbooks yet">The supervisor saves one after a team job goes well, or add your own.</EmptyState>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {list.data.playbooks.map((p) => (
              <li key={p.id} className="flex items-start gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{p.name}<Badge>v{p.version}</Badge>{p.kind && <Badge>{p.kind}</Badge>}<Badge tone={p.source === "you" ? "accent" : "neutral"}>{p.source === "you" ? "by you" : "by the agent"}</Badge></p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted">{p.instructions}</p>
                  <p className="mt-1 text-xs tabular-nums">{p.uses ? `Worked ${p.wins} of ${p.uses} times` : "Not used yet"}{p.questions ? ` · ${Object.keys(p.questions).length} decision questions` : ""} · {timeAgo(p.updated_at)}</p>
                </div>
                <IconButton label={`Edit ${p.name}`} onClick={() => setEditing(p)}><Pencil className="size-4" /></IconButton>
                <IconButton label={`Delete ${p.name}`} onClick={() => setDeleting(p)}><Trash2 className="size-4" /></IconButton>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
      {editing && <PlaybookEditor initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void list.reload(); }} />}
      <ConfirmDialog open={Boolean(deleting)} onCancel={() => setDeleting(null)} onConfirm={() => deleting && void remove(deleting)} confirmLabel="Delete" title={`Delete ${deleting?.name ?? "playbook"}?`} body="The supervisor will no longer find it." />
    </>
  );
}
