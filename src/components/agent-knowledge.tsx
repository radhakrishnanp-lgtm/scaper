"use client";

import { useState } from "react";
import { BookOpenText, FileText, GraduationCap, Pencil, Plus, Star, Trash2 } from "lucide-react";
import type { Note, NoteKind, Review } from "@/server/repo/knowledge";
import { ConfirmDialog, Dialog } from "@/components/dialog";
import { Markdown } from "@/components/markdown";
import { useToast } from "@/components/toast";
import { Badge, Button, EmptyState, ErrorNote, Field, IconButton, Input, LoadingRows, Select, Tabs, Textarea } from "@/components/ui";
import { api, ClientApiError, errorText } from "@/lib/api-client";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type Knowledge = {
  guide: string; topics: { id: string; title: string }[]; gaps: { pages: string[]; tools: string[]; topics: string[] };
  notes: Note[]; reviews: Review[]; stats: { reviews: number; average: number | null; lastWeek: number }; folder: string;
};
const KIND_LABEL: Record<NoteKind, string> = { "how-to": "How-to", site: "Site", lesson: "Lesson", reference: "Reference" };
const scoreTone = (s: number) => (s >= 4 ? "success" : s === 3 ? "warning" : "danger") as "success" | "warning" | "danger";

/** One run's self-review, under the answer. */
export function ReviewCard({ review }: { review: Review }) {
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3 text-sm">
      <p className="flex flex-wrap items-center gap-2 font-medium"><GraduationCap className="size-4 text-muted" />Self-review<Badge tone={scoreTone(review.score)}><Star className="size-3" />{review.score}/5</Badge>
        {review.note_name && <Badge><FileText className="size-3" />updated note {review.note_name}</Badge>}</p>
      <p className="mt-1 text-muted">{review.summary}</p>
      {review.problems.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-muted">{review.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
      {review.lesson && <p className="mt-1 text-xs"><span className="font-medium">Lesson:</span> {review.lesson}</p>}
    </div>
  );
}

function NoteEditor({ note, onClose, onSaved }: { note: Note | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(note?.title ?? "");
  const [kind, setKind] = useState<NoteKind>(note?.kind ?? "how-to");
  const [body, setBody] = useState(note?.body ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErrors({});
    try {
      if (note) await api(`/api/knowledge/notes/${note.id}`, { method: "PUT", body: { title, kind, body } });
      else await api("/api/knowledge/notes", { body: { title, kind, body } });
      toast.success(note ? "Note saved as a new version" : "Note added");
      onSaved(); onClose();
    } catch (e) {
      if (e instanceof ClientApiError && e.fields) setErrors(e.fields);
      toast.error("Could not save the note", errorText(e));
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} xl title={note ? `Edit ${note.title}` : "New note"} description="The agent reads notes before jobs they cover. Write facts and steps, never keys or passwords."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => void save()}>Save note</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-[1fr_200px]">
          <Field label="Title" error={errors.title}>{(f) => <Input {...f} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Amazon India: product pages" />}</Field>
          <Field label="Kind">{(f) => <Select {...f} value={kind} onChange={(e) => setKind(e.target.value as NoteKind)}>{Object.entries(KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}</Field>
        </div>
        <Field label="Note (Markdown)" error={errors.body}>{(f) => <Textarea {...f} className="min-h-72 font-mono text-xs" value={body} onChange={(e) => setBody(e.target.value)} placeholder={"## What works\n- Product title: #productTitle\n- Price: .a-price .a-offscreen\n\n## Watch out\n- Search pages show sponsored items first"} />}</Field>
      </div>
    </Dialog>
  );
}

/** What the agent knows: the guide it gets on every request, the notes it wrote, and how it rated its own work. */
export function KnowledgeDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const data = useApi<Knowledge>("/api/knowledge");
  const [tab, setTab] = useState<"guide" | "notes" | "reviews">("notes");
  const [open, setOpen] = useState<Note | null>(null);
  const [editing, setEditing] = useState<Note | "new" | null>(null);
  const [deleting, setDeleting] = useState<Note | null>(null);
  const k = data.data;
  const remove = async (n: Note) => {
    try { await api(`/api/knowledge/notes/${n.id}`, { method: "DELETE" }); toast.success("Note deleted"); setDeleting(null); setOpen(null); void data.reload(); }
    catch (e) { toast.error("Could not delete", errorText(e)); }
  };
  return (
    <>
      <Dialog open={!editing && !deleting} onClose={onClose} xl title="What the agent knows"
        description="The guide is built from the app on every request, so new features appear on their own. Notes are the agent's own Markdown (also .md files in the data folder). Reviews are its scores for its own finished jobs."
        footer={<>{tab === "notes" && <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>New note</Button>}<Button onClick={onClose}>Close</Button></>}>
        {data.error ? <ErrorNote message={data.error} onRetry={data.reload} /> : !k ? <LoadingRows rows={4} /> : (
          <div className="space-y-4">
            <Tabs value={tab} onChange={(v) => { setTab(v); setOpen(null); }} size="sm" tabs={[
              { value: "notes", label: "Notes", icon: <FileText className="size-4" />, count: k.notes.length },
              { value: "guide", label: "Guide", icon: <BookOpenText className="size-4" /> },
              { value: "reviews", label: "Self-reviews", icon: <GraduationCap className="size-4" />, count: k.stats.reviews },
            ]} />
            {tab === "guide" && (
              <div className="space-y-2">
                <p className="text-xs text-muted">{k.topics.length} topics. The agent gets a short version of this in every request and reads a topic in full with app_guide.</p>
                <div className="scroll-thin max-h-[55vh] overflow-y-auto rounded-xl border border-border p-4"><Markdown text={k.guide} /></div>
              </div>
            )}
            {tab === "notes" && (open ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>← All notes</Button>
                  <span className="font-medium">{open.title}</span><Badge>{KIND_LABEL[open.kind]}</Badge><Badge>v{open.version}</Badge><Badge>{open.source === "you" ? "by you" : "by the agent"}</Badge>
                  <span className="ml-auto flex gap-1">
                    <IconButton label={`Edit ${open.title}`} onClick={() => setEditing(open)}><Pencil className="size-4" /></IconButton>
                    <IconButton label={`Delete ${open.title}`} onClick={() => setDeleting(open)}><Trash2 className="size-4" /></IconButton>
                  </span>
                </div>
                <p className="font-mono text-xs text-muted">{k.folder}/{open.name}.md · updated {timeAgo(open.updated_at)} · read {open.uses} time{open.uses === 1 ? "" : "s"}</p>
                <div className="scroll-thin max-h-[50vh] overflow-y-auto rounded-xl border border-border p-4"><Markdown text={open.body} /></div>
              </div>
            ) : k.notes.length ? (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {k.notes.map((n) => (
                  <li key={n.id}>
                    <button type="button" className="flex w-full flex-wrap items-center gap-2 px-3 py-2.5 text-left hover:bg-surface-2/60" onClick={() => setOpen(n)}>
                      <FileText className="size-4 text-muted" /><span className="font-medium">{n.title}</span><Badge>{KIND_LABEL[n.kind]}</Badge>
                      {n.source === "you" && <Badge tone="accent">by you</Badge>}
                      <span className="ml-auto text-xs text-muted">v{n.version} · {timeAgo(n.updated_at)}</span>
                      <span className="w-full truncate pl-6 text-xs text-muted">{n.body.replace(/[#*`>]/g, " ").replace(/\s+/g, " ").slice(0, 160)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <EmptyState icon={<FileText className="size-5" />} title="No notes yet">The agent writes notes as it learns: site quirks, selectors that worked, procedures, and a list of lessons from reviewing its own jobs. You can add your own too.</EmptyState>)}
            {tab === "reviews" && (k.reviews.length ? (
              <div className="space-y-2">
                <p className="text-sm text-muted">Average {k.stats.average}/5 over {k.stats.reviews} jobs, {k.stats.lastWeek} in the last 7 days.</p>
                <ul className="space-y-2">{k.reviews.map((r) => <li key={r.id}><ReviewCard review={r} /><p className="mt-0.5 text-right text-xs text-muted">{timeAgo(r.created_at)}</p></li>)}</ul>
              </div>
            ) : <EmptyState icon={<GraduationCap className="size-5" />} title="No reviews yet">After each job with a few steps, the agent scores its own work, notes what went wrong and keeps one lesson. Turn it on or off in Settings → AI → Learning.</EmptyState>)}
          </div>
        )}
      </Dialog>
      {editing && <NoteEditor note={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { void data.reload(); setOpen(null); }} />}
      <ConfirmDialog open={Boolean(deleting)} onCancel={() => setDeleting(null)} onConfirm={() => deleting && void remove(deleting)} confirmLabel="Delete" title={`Delete ${deleting?.title ?? "note"}?`} body="The agent will no longer read it. Its .md file is removed too." />
    </>
  );
}
