"use client";

import { useEffect, useRef, useState } from "react";
import { Bookmark as BookmarkIcon, Eraser, ExternalLink, History, Puzzle, Send, Sparkles, StickyNote, Trash2, Upload } from "lucide-react";
import type { AgentRun } from "@/server/repo/agent";
import type { Annotation, Bookmark, Extension, HistoryEntry } from "@/server/repo/browser";
import { Turn } from "./agent-run";
import { ConfirmDialog } from "./dialog";
import { useToast } from "./toast";
import { Badge, Button, EmptyState, IconButton, Input, SearchInput, Switch, Textarea } from "./ui";
import { api, errorText } from "@/lib/api-client";
import { dateTime, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";

export const NOTE_COLORS: Record<string, string> = { amber: "#f59e0b", red: "#ef4444", green: "#22c55e", blue: "#3b82f6", violet: "#8b5cf6" };

/** Ask your AI about the open page; the page and your annotations go with each question. */
export function AskPanel({ hasNotes, open }: { hasNotes: number; open: boolean }) {
  const toast = useToast();
  const [ids, setIds] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [model, setModel] = useState<"main" | "fast">("main");
  const [sending, setSending] = useState(false);
  const last = ids.at(-1) ?? null;
  const [runs, setRuns] = useState<Record<string, AgentRun>>({});
  const lastRun = last ? runs[last] : undefined;
  const running = Boolean(last && (!lastRun || lastRun.status === "running"));
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!last || !running) return;
    let stop = false;
    const tick = async () => {
      try { const r = await api<{ run: AgentRun }>(`/api/agent/runs/${last}`); if (!stop) setRuns((m) => ({ ...m, [last]: r.run })); } catch { /* next tick */ }
    };
    void tick();
    const t = setInterval(() => void tick(), 1200);
    return () => { stop = true; clearInterval(t); };
  }, [last, running]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [ids.length, lastRun?.steps.length, lastRun?.status]);

  const send = async (prompt = text) => {
    if (!prompt.trim()) return;
    setSending(true);
    try {
      const r = await api<{ run: AgentRun }>("/api/browser/ask", { body: { prompt, model, followUpOf: lastRun && lastRun.status !== "running" ? lastRun.id : undefined } });
      setRuns((m) => ({ ...m, [r.run.id]: r.run }));
      setIds((x) => [...x, r.run.id]);
      setText("");
    } catch (e) { toast.error("Could not ask your AI", errorText(e)); } finally { setSending(false); }
  };
  const reload = async (id: string) => { const r = await api<{ run: AgentRun }>(`/api/agent/runs/${id}`); setRuns((m) => ({ ...m, [id]: r.run })); };
  const quick = ["Summarise this page", "Extract the items on this page as a table", hasNotes ? "Explain what I marked" : "What can I scrape here?", "Make a task that scrapes this every day"];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        {!ids.length && (
          <div className="space-y-3 text-sm text-muted">
            <p>Your AI sees the page you have open{hasNotes ? ` and your ${hasNotes} annotation${hasNotes === 1 ? "" : "s"}` : ""}. It can read it, list its links and buttons, and, with your OK, click and type in it while you watch.</p>
            {!open && <p>Open the browser first.</p>}
            <div className="flex flex-wrap gap-1.5">{quick.map((q) => <button key={q} type="button" onClick={() => void send(q)} disabled={!open || sending} className="rounded-full border border-border px-2.5 py-1 text-xs hover:border-accent hover:text-accent disabled:opacity-50">{q}</button>)}</div>
          </div>
        )}
        {ids.map((id) => {
          const r = runs[id];
          if (!r) return null;
          return (
            <div key={id} className="space-y-2">
              <Turn run={r} compact={id !== last} onAnswered={() => void reload(id)} />
            </div>
          );
        })}
        <div ref={end} />
      </div>
      <form className="space-y-2 border-t border-border p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <Textarea aria-label="Ask your AI about this page" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about this page, or tell your AI what to do in it"
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
        <div className="flex items-center justify-between gap-2">
          <select aria-label="Model" className="h-8 rounded-lg border border-border bg-surface px-2 text-xs" value={model} onChange={(e) => setModel(e.target.value as "main" | "fast")}>
            <option value="main">Main model</option><option value="fast">Fast model</option>
          </select>
          <div className="flex gap-2">
            {ids.length > 0 && <Button size="sm" variant="ghost" onClick={() => { setIds([]); setRuns({}); }}>New chat</Button>}
            <Button size="sm" type="submit" icon={<Send className="size-4" />} loading={sending} disabled={running || !text.trim()}>{running ? "Working…" : "Ask"}</Button>
          </div>
        </div>
      </form>
    </div>
  );
}

export function NotesPanel({ notes, onChanged, onAsk, url, incognito }: { notes: Annotation[]; onChanged: () => void; onAsk: () => void; url: string; incognito: boolean }) {
  const toast = useToast();
  const [edit, setEdit] = useState<Record<string, string>>({});
  const save = async (a: Annotation) => {
    try { await api(`/api/browser/annotations/${a.id}`, { method: "PATCH", body: { note: edit[a.id] ?? a.note } }); setEdit((m) => { const n = { ...m }; delete n[a.id]; return n; }); onChanged(); }
    catch (e) { toast.error("Could not save the note", errorText(e)); }
  };
  const remove = async (a: Annotation) => { try { await api(`/api/browser/annotations/${a.id}`, { method: "DELETE" }); onChanged(); } catch (e) { toast.error("Could not remove it", errorText(e)); } };
  const clear = async () => { try { await api(`/api/browser/annotations?url=${encodeURIComponent(url)}`, { method: "DELETE" }); onChanged(); } catch (e) { toast.error("Could not clear", errorText(e)); } };
  return (
    <div className="space-y-3 overflow-y-auto p-3">
      <p className="text-xs text-muted">Press <strong>Annotate</strong> in the toolbar, then drag a box over anything on the page and write what you want. Your AI reads these boxes, their notes and what is under them.{incognito ? " In incognito they are kept until you close the browser." : ""}</p>
      {!notes.length ? <EmptyState icon={<StickyNote className="size-5" />} title="No annotations on this page" /> : (
        <>
          <ol className="space-y-2">
            {notes.map((a, i) => (
              <li key={a.id} className="space-y-1.5 rounded-xl border border-border p-2.5 text-sm">
                <p className="flex items-center gap-2">
                  <span className="grid size-5 place-items-center rounded-full text-[11px] font-semibold text-white" style={{ background: NOTE_COLORS[a.color] ?? NOTE_COLORS.amber }}>{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted" title={a.element?.selector}>{a.element ? `<${a.element.tag}> ${a.element.text.slice(0, 80)}` : "box"}</span>
                  <IconButton size="sm" label={`Remove annotation ${i + 1}`} onClick={() => void remove(a)}><Trash2 className="size-4" /></IconButton>
                </p>
                <div className="flex gap-1.5">
                  <Input aria-label={`Note ${i + 1}`} className="h-8 min-w-0 flex-1 text-xs" value={edit[a.id] ?? a.note} onChange={(e) => setEdit((m) => ({ ...m, [a.id]: e.target.value }))} placeholder="What should your AI know or do here?" />
                  {edit[a.id] !== undefined && edit[a.id] !== a.note && <Button size="sm" onClick={() => void save(a)}>Save</Button>}
                </div>
              </li>
            ))}
          </ol>
          <div className="flex justify-between gap-2">
            <Button size="sm" variant="ghost" icon={<Eraser className="size-4" />} onClick={() => void clear()}>Clear this page</Button>
            <Button size="sm" variant="secondary" icon={<Sparkles className="size-4" />} onClick={onAsk}>Ask AI about them</Button>
          </div>
        </>
      )}
    </div>
  );
}

export function HistoryPanel({ onOpen, enabled }: { onOpen: (url: string) => void; enabled: boolean }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const h = useApi<{ items: HistoryEntry[] }>(`/api/browser/history?limit=150${debounced ? `&q=${encodeURIComponent(debounced)}` : ""}`);
  const [clearing, setClearing] = useState(false);
  const del = async (body: Record<string, unknown>) => {
    try { const r = await api<{ removed: number }>("/api/browser/history", { method: "DELETE", body }); toast.success("History cleared", `${r.removed} visit${r.removed === 1 ? "" : "s"} removed.`); void h.reload(); }
    catch (e) { toast.error("Could not clear", errorText(e)); }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-2 border-b border-border p-3">
        <SearchInput value={q} onChange={setQ} placeholder="Search history" className="min-w-0 flex-1" />
        <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setClearing(true)}>Clear</Button>
      </div>
      {!enabled && <p className="px-3 pt-2 text-xs text-muted">History is off in Settings → Data, so new visits are not saved.</p>}
      <ul className="min-h-0 flex-1 overflow-y-auto px-1 py-2 text-sm">
        {(h.data?.items ?? []).map((e, i, all) => {
          const dayOf = (t: string) => new Date(t).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
          const day = dayOf(e.visited_at);
          const head = i === 0 || dayOf(all[i - 1]!.visited_at) !== day;
          return (
            <li key={e.id}>
              {head && <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted">{day}</p>}
              <div className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(e.url)} title={e.url}>
                  <span className="block truncate">{e.title || e.url}</span>
                  <span className="block truncate text-xs text-muted">{e.host} · {new Date(e.visited_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
                </button>
                <IconButton size="sm" label="Remove from history" className="opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => void del({ id: e.id })}><Trash2 className="size-4" /></IconButton>
              </div>
            </li>
          );
        })}
        {h.data && !h.data.items.length && <li className="p-3"><EmptyState icon={<History className="size-5" />} title={debounced ? "Nothing matches" : "No history yet"}>Pages you open in the normal profile show up here. Incognito keeps nothing.</EmptyState></li>}
      </ul>
      <ConfirmDialog open={clearing} onCancel={() => setClearing(false)} onConfirm={() => { setClearing(false); void del({ all: true }); }} confirmLabel="Clear history"
        title="Clear all browser history?" body="Removes every visit. Cookies, sign-ins and bookmarks stay. To sign out of sites, clear the profile in Settings or use incognito." />
    </div>
  );
}

export function BookmarksPanel({ items, onOpen, onChanged }: { items: Bookmark[]; onOpen: (url: string) => void; onChanged: () => void }) {
  const toast = useToast();
  const remove = async (b: Bookmark) => { try { await api(`/api/browser/bookmarks/${b.id}`, { method: "DELETE" }); onChanged(); } catch (e) { toast.error("Could not remove it", errorText(e)); } };
  return (
    <ul className="space-y-0.5 overflow-y-auto p-2 text-sm">
      {items.map((b) => (
        <li key={b.id} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2">
          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(b.url)} title={b.url}>
            <span className="block truncate">{b.title || b.url}</span><span className="block truncate text-xs text-muted">{b.url}</span>
          </button>
          <IconButton size="sm" label="Remove bookmark" className="opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => void remove(b)}><Trash2 className="size-4" /></IconButton>
        </li>
      ))}
      {!items.length && <li className="p-2"><EmptyState icon={<BookmarkIcon className="size-5" />} title="No bookmarks yet">Press the star in the address bar to keep a page here.</EmptyState></li>}
    </ul>
  );
}

export function ExtensionsPanel({ items, onChanged, onOpenPage, needsRestart, onRestart, incognito }: {
  items: Extension[]; onChanged: () => void; onOpenPage: (url: string) => void; needsRestart: boolean; onRestart: () => void; incognito: boolean;
}) {
  const toast = useToast();
  const [store, setStore] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [del, setDel] = useState<Extension | null>(null);
  const installed = (name: string) => toast.success(`${name} installed`, "Restart the browser to load it.");
  const fromStore = async () => {
    setBusy("store");
    try { const r = await api<{ extension: Extension }>("/api/browser/extensions", { body: { store } }); setStore(""); installed(r.extension.name); onChanged(); }
    catch (e) { toast.error("Could not install it", errorText(e)); } finally { setBusy(null); }
  };
  const upload = async (f: File) => {
    setBusy("upload");
    try {
      const res = await fetch("/api/browser/extensions", { method: "POST", headers: { "content-type": f.name.endsWith(".crx") ? "application/x-chrome-extension" : "application/zip" }, body: f });
      const j = await res.json() as { extension?: Extension; error?: { message: string } };
      if (!res.ok || !j.extension) throw new Error(j.error?.message ?? `HTTP ${res.status}`);
      installed(j.extension.name); onChanged();
    } catch (e) { toast.error("Could not install it", (e as Error).message); } finally { setBusy(null); if (file.current) file.current.value = ""; }
  };
  const toggle = async (x: Extension, on: boolean) => { try { await api(`/api/browser/extensions/${x.id}`, { method: "PATCH", body: { enabled: on } }); onChanged(); } catch (e) { toast.error("Could not change it", errorText(e)); } };
  const remove = async (x: Extension) => { try { await api(`/api/browser/extensions/${x.id}`, { method: "DELETE" }); setDel(null); onChanged(); } catch (e) { toast.error("Could not remove it", errorText(e)); } };
  return (
    <div className="space-y-4 overflow-y-auto p-3 text-sm">
      {needsRestart && <div className="flex items-center justify-between gap-2 rounded-xl border border-warning/40 bg-warning/10 p-2.5 text-xs"><span>Restart the browser to apply extension changes.</span><Button size="sm" onClick={onRestart}>Restart</Button></div>}
      {incognito && <p className="text-xs text-muted">Incognito runs without extensions, like Chrome.</p>}
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (store.trim()) void fromStore(); }}>
        <p className="text-xs font-medium">From the Chrome Web Store</p>
        <div className="flex gap-2">
          <Input aria-label="Chrome Web Store link" className="h-9 min-w-0 flex-1 text-xs" value={store} onChange={(e) => setStore(e.target.value)} placeholder="https://chromewebstore.google.com/detail/…" />
          <Button size="sm" type="submit" loading={busy === "store"} disabled={!store.trim()}>Add</Button>
        </div>
      </form>
      <div>
        <input ref={file} type="file" accept=".zip,.crx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        <Button size="sm" variant="secondary" icon={<Upload className="size-4" />} loading={busy === "upload"} onClick={() => file.current?.click()}>Upload a .zip or .crx</Button>
        <p className="mt-1 text-xs text-muted">An unpacked extension folder zipped up works too. Extensions that change pages (ad blockers, dark mode, translators, password managers) work; toolbar pop-ups open as a tab.</p>
      </div>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {items.map((x) => (
          <li key={x.id} className="space-y-1.5 p-2.5">
            <div className="flex items-start gap-2">
              <Puzzle className="mt-0.5 size-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1"><p className="font-medium">{x.name} <span className="text-xs font-normal text-muted">{x.version}</span></p>{x.description && <p className="line-clamp-2 text-xs text-muted">{x.description}</p>}</div>
              <Switch checked={x.enabled} onChange={(v) => void toggle(x, v)} label={x.enabled ? "On" : "Off"} />
            </div>
            <div className="flex flex-wrap items-center gap-1 pl-6">
              <Badge>{x.source === "store" ? "Web Store" : "uploaded"}</Badge>
              <span className="text-xs text-muted" title={dateTime(x.installed_at)}>{timeAgo(x.installed_at)}</span>
              {x.popup_page && <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" />} disabled={incognito} onClick={() => onOpenPage(x.popup_page!)}>Open</Button>}
              {x.options_page && <Button size="sm" variant="ghost" disabled={incognito} onClick={() => onOpenPage(x.options_page!)}>Options</Button>}
              <IconButton size="sm" label={`Remove ${x.name}`} className="ml-auto" onClick={() => setDel(x)}><Trash2 className="size-4" /></IconButton>
            </div>
          </li>
        ))}
        {!items.length && <li className="p-3 text-xs text-muted">No extensions yet.</li>}
      </ul>
      <ConfirmDialog open={Boolean(del)} onCancel={() => setDel(null)} onConfirm={() => del && void remove(del)} confirmLabel="Remove" title={`Remove ${del?.name ?? "this extension"}?`} body="Its files are deleted. Its saved settings in the browser profile stay until you clear the profile." />
    </div>
  );
}
