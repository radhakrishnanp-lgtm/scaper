"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { Bell, Paperclip, Send, Sparkles, X } from "lucide-react";
import type { AgentRun } from "@/server/repo/agent";
import type { Notification } from "@/server/repo/notifications";
import { SendOrStop, STOP_WORDS, stopRun, Turn } from "./agent-run";
import { useLiveEvents } from "./live";
import { useToast } from "./toast";
import { Badge, Button, Textarea } from "./ui";
import { api, errorText } from "@/lib/api-client";
import { timeAgo } from "@/lib/format";

/**
 * Your AI on every page. The General chat follows you around (it continues where you left it, on any page);
 * each data set, task, watcher or product you ask about gets its own session, so that chat stays on that one thing.
 * It knows the page you are on, takes rows you selected or an alert you point at, and shows updates as they happen.
 * It is the same agent with the same tools, memory and approvals as the AI agent page.
 */

export type AssistantRows = { source: string; columns: string[]; items: Record<string, unknown>[] };
export type AssistantFocus = { kind: string; id?: string; title: string; body?: string; url?: string | null };
/** A focused chat about one thing. `focus` goes with every question in it. */
export type AssistantSession = { key: string; name: string; focus?: AssistantFocus };
type Open = { rows?: AssistantRows; focus?: AssistantFocus; session?: AssistantSession };

const EVENT = "scaper-assistant";
const THREAD_KEY = "scaper-assistant-thread";
const SESSIONS_KEY = "scaper-assistant-sessions";
const MAX_ROWS = 500;

/** Opens the assistant from anywhere, optionally with rows or one item attached. */
export function openAssistant(o: Open = {}) {
  window.dispatchEvent(new CustomEvent<Open>(EVENT, { detail: o }));
}

const threadKey = (session: AssistantSession | null) => (session ? `${THREAD_KEY}:${session.key}` : THREAD_KEY);
const readThread = (session: AssistantSession | null): string[] => {
  try { const v = JSON.parse(localStorage.getItem(threadKey(session)) ?? "[]") as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-20) : []; } catch { return []; }
};
const writeThread = (session: AssistantSession | null, ids: string[]) => { try { localStorage.setItem(threadKey(session), JSON.stringify(ids.slice(-20))); } catch { /* private window */ } };
const readSessions = (): AssistantSession[] => {
  try { const v = JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? "[]") as unknown; return Array.isArray(v) ? (v as AssistantSession[]).filter((x) => x && typeof x.key === "string" && typeof x.name === "string").slice(0, 12) : []; } catch { return []; }
};
const writeSessions = (list: AssistantSession[]) => { try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(list.slice(0, 12))); } catch { /* private window */ } };

const QUICK_ROWS = ["Download the files these rows link to", "Check which of these links still work", "Summarise these rows", "Watch these pages for changes"];
const QUICK_FOCUS = ["Explain this", "What should I do about it?", "Make a watcher or bot for this"];
const QUICK_SESSION = ["Summarise this", "Download the files it links to", "What changed lately?", "Find problems in this data"];
const QUICK = ["What's new since yesterday?", "Review my changes inbox", "Any price drops on my products?", "Which tasks failed lately, and why?"];

/** "Ask AI" on a page about one thing: opens that thing's own chat session. */
export function AskAiButton({ session, label = "Ask AI", variant = "secondary" }: { session: AssistantSession; label?: string; variant?: "secondary" | "ghost" }) {
  return <Button variant={variant} icon={<Sparkles className="size-4 text-accent" />} onClick={() => openAssistant({ session })}>{label}</Button>;
}

export function AssistantButton() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"chat" | "updates">("chat");
  const [attach, setAttach] = useState<Open>({});
  const [session, setSession] = useState<AssistantSession | null>(null);
  const [sessions, setSessions] = useState<AssistantSession[]>([]);
  const [fresh, setFresh] = useState(0);
  const pick = (next: AssistantSession | null) => {
    setSession(next);
    if (!next) return;
    const list = [next, ...readSessions().filter((x) => x.key !== next.key)];
    writeSessions(list);
    setSessions(list);
  };
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<Open>).detail ?? {};
      setAttach({ rows: d.rows ? { ...d.rows, items: d.rows.items.slice(0, MAX_ROWS) } : undefined, focus: d.focus });
      if (d.session) pick(d.session); else setSessions(readSessions());
      setTab("chat");
      setOpen(true);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  useLiveEvents((e) => { if (e.type === "notification" && !open) setFresh((n) => n + 1); });
  // The Browser page and the AI agent page have their own chat.
  if (pathname.startsWith("/browser") || pathname.startsWith("/agent") || pathname.startsWith("/login")) return null;
  return (
    <>
      <Button size="sm" variant="secondary" icon={<Sparkles className="size-4 text-accent" />} aria-label="Ask AI" aria-expanded={open}
        onClick={() => { setOpen((v) => !v); setFresh(0); setSessions(readSessions()); }}>
        <span className="hidden sm:inline">Ask AI</span>
        {fresh > 0 && <span className="ml-1 rounded-full bg-accent px-1.5 text-[10px] text-white">{fresh}</span>}
      </Button>
      {open && createPortal(
        <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[440px] flex-col border-l border-border bg-surface shadow-pop" aria-label="AI assistant">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Sparkles className="size-4 text-accent" />
            <span className="font-semibold">Your AI</span>
            <div className="ml-2 flex rounded-lg bg-surface-2 p-0.5 text-xs" role="tablist" aria-label="Assistant view">
              {(["chat", "updates"] as const).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                  className={`rounded-md px-2.5 py-1 ${tab === t ? "bg-surface font-medium shadow-sm" : "text-muted"}`}>{t === "chat" ? "Chat" : "Updates"}</button>
              ))}
            </div>
            <span className="flex-1" />
            <select aria-label="Chat session" className="h-7 max-w-[140px] truncate rounded-lg border border-border bg-surface px-1.5 text-xs" value={session?.key ?? ""}
              onChange={(e) => { const s = sessions.find((x) => x.key === e.target.value) ?? null; pick(s); setAttach({}); }}>
              <option value="">General</option>
              {sessions.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}
            </select>
            <button type="button" aria-label="Close the assistant" className="rounded p-1 text-muted hover:bg-surface-2" onClick={() => setOpen(false)}><X className="size-4" /></button>
          </div>
          <div className={tab === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            {session && (
              <div className="flex items-center gap-2 border-b border-border bg-accent-soft/60 px-3 py-1.5 text-xs">
                <Sparkles className="size-3.5 text-accent" />
                <span className="min-w-0 flex-1 truncate">Only about <strong>{session.name}</strong></span>
                <button type="button" className="text-accent hover:underline" onClick={() => { pick(null); setAttach({}); }}>Back to General</button>
              </div>
            )}
            <Chat key={session?.key ?? "general"} page={pathname} session={session} attach={attach} onDetach={() => setAttach({})} />
          </div>
          {tab === "updates" && <Updates onAsk={(n) => { setAttach({ focus: { kind: n.kind, id: n.id, title: n.title, body: n.body, url: n.url } }); setTab("chat"); }} />}
        </aside>,
        document.body,
      )}
    </>
  );
}

function Chat({ page, session, attach, onDetach }: { page: string; session: AssistantSession | null; attach: Open; onDetach: () => void }) {
  const toast = useToast();
  const [ids, setIds] = useState<string[]>([]);
  const [runs, setRuns] = useState<Record<string, AgentRun>>({});
  const [text, setText] = useState("");
  const [model, setModel] = useState<"main" | "fast">("main");
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const last = ids.at(-1) ?? null;
  const lastRun = last ? runs[last] : undefined;
  const running = Boolean(last && (!lastRun || lastRun.status === "running"));

  // The conversation continues across pages and reloads.
  useEffect(() => {
    const saved = readThread(session);
    if (!saved.length) return;
    void Promise.all(saved.map((id) => api<{ run: AgentRun }>(`/api/agent/runs/${id}`).then((r) => r.run).catch(() => null))).then((list) => {
      const ok = list.filter((r): r is AgentRun => Boolean(r));
      setRuns(Object.fromEntries(ok.map((r) => [r.id, r])));
      setIds(ok.map((r) => r.id));
    });
  }, [session]);
  useEffect(() => {
    if (!last || !running) return;
    let stop = false;
    const tick = async () => { try { const r = await api<{ run: AgentRun }>(`/api/agent/runs/${last}`); if (!stop) setRuns((m) => ({ ...m, [last]: r.run })); } catch { /* next tick */ } };
    void tick();
    const t = setInterval(() => void tick(), 1200);
    return () => { stop = true; clearInterval(t); };
  }, [last, running]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [ids.length, lastRun?.steps.length, lastRun?.status]);

  const send = async (prompt = text) => {
    if (!prompt.trim()) return;
    // Typing "stop" while it works stops it.
    if (running) { if (last && STOP_WORDS.test(prompt)) { await stopRun(last).catch(() => undefined); setText(""); void reload(last); } return; }
    setSending(true);
    try {
      const r = await api<{ run: AgentRun }>("/api/assistant", { body: {
        prompt, model, page, followUpOf: lastRun && lastRun.status !== "running" ? lastRun.id : undefined, rows: attach.rows, focus: attach.focus ?? session?.focus,
        session: session ? { key: session.key, name: session.name } : undefined,
      } });
      setRuns((m) => ({ ...m, [r.run.id]: r.run }));
      setIds((x) => { const n = [...x, r.run.id]; writeThread(session, n); return n; });
      setText("");
      onDetach();
    } catch (e) { toast.error("Could not ask your AI", errorText(e)); } finally { setSending(false); }
  };
  const reload = async (id: string) => { const r = await api<{ run: AgentRun }>(`/api/agent/runs/${id}`); setRuns((m) => ({ ...m, [id]: r.run })); };
  const quick = attach.rows ? QUICK_ROWS : attach.focus ? QUICK_FOCUS : session ? QUICK_SESSION : QUICK;
  return (
    <>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        {!ids.length && (
          <div className="space-y-3 text-sm text-muted">
            {session ? <p>This chat is only about <strong className="text-text">{session.name}</strong>. Ask about it, or tell your AI what to do with it, like downloading the files it links to. It has its own history, apart from the General chat.</p> : <p>Ask about anything in Scaper, or tell it what to do: your tasks and data, watchers and changes, prices and deals, alerts, downloads and bots. It knows which page you are on and remembers what you tell it to. Changes wait for your OK.</p>}
          </div>
        )}
        {ids.map((id) => runs[id] && <Turn key={id} run={runs[id]} compact={id !== last} onAnswered={() => void reload(id)} />)}
        <div ref={end} />
      </div>
      <form className="space-y-2 border-t border-border p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        {(attach.rows || attach.focus) && (
          <div className="flex items-center gap-2 rounded-lg bg-accent-soft px-2.5 py-1.5 text-xs">
            <Paperclip className="size-3.5 text-accent" />
            <span className="min-w-0 flex-1 truncate">{attach.rows ? `${attach.rows.items.length} row${attach.rows.items.length === 1 ? "" : "s"} from ${attach.rows.source || "this table"}` : attach.focus!.title}</span>
            <button type="button" aria-label="Remove the attachment" onClick={onDetach}><X className="size-3.5" /></button>
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">{quick.map((q) => <button key={q} type="button" onClick={() => void send(q)} disabled={sending || running} className="rounded-full border border-border px-2.5 py-1 text-xs text-muted hover:border-accent hover:text-accent disabled:opacity-50">{q}</button>)}</div>
        <Textarea aria-label="Ask your AI" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask or tell your AI what to do"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <div className="flex items-center justify-between gap-2">
          <select aria-label="Model" className="h-8 rounded-lg border border-border bg-surface px-2 text-xs" value={model} onChange={(e) => setModel(e.target.value as "main" | "fast")}>
            <option value="main">Main model</option><option value="fast">Fast model</option>
          </select>
          <div className="flex gap-2">
            {ids.length > 0 && <Button size="sm" variant="ghost" onClick={() => { setIds([]); setRuns({}); writeThread(session, []); }}>New chat</Button>}
            <SendOrStop running={running} runId={last} sending={sending} disabled={!text.trim()} icon={<Send className="size-4" />} onStopped={() => last && void reload(last)} />
          </div>
        </div>
      </form>
    </>
  );
}

/** Alerts as they come in (changes, prices, deals, runs, bots), each with a button to ask your AI about it. */
function Updates({ onAsk }: { onAsk: (n: Notification) => void }) {
  const [items, setItems] = useState<Notification[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let stop = false;
    void api<{ items: Notification[] }>("/api/notifications?limit=40").then((r) => { if (!stop) setItems(r.items); }).catch(() => { if (!stop) setItems([]); });
    return () => { stop = true; };
  }, [tick]);
  useLiveEvents((e) => { if (e.type === "notification") setTick((t) => t + 1); });
  if (!items) return <div className="p-3"><div className="skeleton h-24 rounded-lg" /></div>;
  if (!items.length) return <p className="p-4 text-sm text-muted">No updates yet. Watcher changes, price alerts, new deals, finished runs and bot messages show up here as they happen.</p>;
  return (
    <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
      {items.map((n) => (
        <li key={n.id} className="space-y-1 px-3 py-2.5">
          <div className="flex items-center gap-2 text-xs text-muted"><Bell className="size-3.5" /><Badge>{n.kind}</Badge>{!n.read_at && <span className="size-1.5 rounded-full bg-accent" aria-label="unread" />}<span className="ml-auto">{timeAgo(n.created_at)}</span></div>
          <p className="text-sm font-medium">{n.title}</p>
          {n.body && <p className="line-clamp-2 text-xs text-muted">{n.body}</p>}
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" icon={<Sparkles className="size-3.5" />} onClick={() => onAsk(n)}>Ask AI</Button>
            {n.url && <a href={n.url} className="self-center text-xs text-accent hover:underline">Open</a>}
          </div>
        </li>
      ))}
    </ul>
  );
}
