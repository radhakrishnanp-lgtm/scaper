"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import {
  AppWindow, ArrowLeft, ArrowRight, Bookmark as BookmarkIcon, Camera, EyeOff, Globe, History, MoreHorizontal, PanelRightClose, PanelRightOpen, Plus,
  AlertTriangle, Download, ExternalLink, FileSearch, Power, Puzzle, RotateCw, Settings as SettingsIcon, Sparkles, SquareDashedMousePointer, Star, StickyNote, X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Annotation, Bookmark, Extension } from "@/server/repo/browser";
import type { LiveState } from "@/server/live-browser/session";
import { AskPanel, BookmarksPanel, ExtensionsPanel, HistoryPanel, NOTE_COLORS, NotesPanel } from "@/components/browser-panels";
import { ConfirmDialog, Dialog } from "@/components/dialog";
import { Menu } from "@/components/menu";
import { useToast } from "@/components/toast";
import { Badge, Button, Callout, IconButton, Input, Segmented, Switch, Tabs } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { useApi } from "@/lib/use-api";

type Info = {
  state: LiveState; annotations: Annotation[]; bookmarks: Bookmark[]; extensions: Extension[];
  settings: {
    quality: number; home: string; search: string; history: boolean; historyDays: number; privateMode: boolean;
    engine: Engine; window: boolean; canWindow: boolean; firefoxInstalled: boolean;
  };
};
type Engine = "chromium" | "chrome" | "msedge" | "firefox";
const ENGINE_NAME: Record<Engine, string> = { chromium: "Chromium", chrome: "Google Chrome", msedge: "Microsoft Edge", firefox: "Firefox" };
type Frame = { data: string; width: number; height: number; scrollX: number; scrollY: number; tabId: string };
type Side = "ai" | "notes" | "history" | "bookmarks" | "extensions";
type Ev = Record<string, unknown> & { type: string };

/** Which engine opens (Chromium, Chrome, Edge or Firefox) and whether a real window shows too. */
function EngineChooser({ settings, onChanged }: { settings: Info["settings"]; onChanged: () => void }) {
  const toast = useToast();
  const [installing, setInstalling] = useState<{ percent: number | null; line: string } | null>(null);
  const save = async (data: Partial<{ browserEngine: Engine; browserWindow: boolean }>) => {
    try { await api("/api/settings", { method: "PUT", body: { data } }); onChanged(); }
    catch (e) { toast.error("Could not save", errorText(e)); }
  };
  const installFirefox = async () => {
    setInstalling({ percent: 0, line: "Starting…" });
    try {
      await api("/api/system/browser", { body: { action: "install", which: "firefox" } });
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const st = await api<{ install: { state: string; percent: number | null; log: string[]; error: string | null } }>("/api/system/browser");
        setInstalling({ percent: st.install.percent, line: st.install.log.at(-1) ?? "" });
        if (st.install.state === "done") { toast.success("Firefox is installed", "Open the browser to start it."); break; }
        if (st.install.state === "error") { toast.error("Firefox could not be installed", st.install.error ?? ""); break; }
      }
    } catch (e) { toast.error("Could not install", errorText(e)); }
    setInstalling(null);
    onChanged();
  };
  return (
    <div className="space-y-3 rounded-2xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-medium">Engine</span>
        <Segmented label="Engine" value={settings.engine} onChange={(v) => void save({ browserEngine: v })} options={(Object.keys(ENGINE_NAME) as Engine[]).map((k) => ({ value: k, label: ENGINE_NAME[k] }))} />
      </div>
      <p className="text-xs text-muted">
        {settings.engine === "chromium" && "Scaper's Chromium, the engine inside Chrome. Add-ons work here."}
        {settings.engine === "chrome" && "The Google Chrome installed on this computer, with its own Scaper profile. Add-ons from the Add-ons tab load in Chromium only."}
        {settings.engine === "msedge" && "The Microsoft Edge installed on this computer, with its own Scaper profile. Add-ons from the Add-ons tab load in Chromium only."}
        {settings.engine === "firefox" && "Mozilla Firefox. Some sites work better in it. Add-ons from the Add-ons tab load in Chromium only."}
      </p>
      {settings.engine === "firefox" && !settings.firefoxInstalled && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface-2 p-3 text-sm">
          <Download className="size-4 text-accent" />
          <span className="flex-1">{installing ? `Installing Firefox${installing.percent != null ? ` (${installing.percent}%)` : ""}… ${installing.line}` : "Firefox is not installed for Scaper yet (about 90 MB, once)."}</span>
          <Button size="sm" loading={Boolean(installing)} onClick={() => void installFirefox()}>Install Firefox</Button>
        </div>
      )}
      <Switch checked={settings.window} onChange={(v) => void save({ browserWindow: v })} label="Show a real window too"
        description={settings.canWindow ? "The browser also opens as a normal window on this computer. Use it directly, or keep using it here; both are the same browser." : "This computer has no screen for a window, so the browser runs inside Scaper only."} disabled={!settings.canWindow} />
    </div>
  );
}

/** Sends input in order, a batch at a time, so fast typing never arrives scrambled. */
class InputQueue {
  private queue: Ev[] = [];
  private busy = false;
  push(e: Ev) {
    // Only the latest mouse position matters.
    const last = this.queue.at(-1);
    if (e.type === "mouse" && e.kind === "move" && last?.type === "mouse" && last.kind === "move") this.queue[this.queue.length - 1] = e;
    else this.queue.push(e);
    void this.flush();
  }
  private async flush() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    const events = this.queue.splice(0, 50);
    try {
      const res = await fetch("/api/browser/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events }) });
      if (!res.ok) { const j = await res.json().catch(() => null) as { error?: { message?: string } } | null; window.dispatchEvent(new CustomEvent("scaper-browser-error", { detail: j?.error?.message ?? `HTTP ${res.status}` })); }
    } catch { /* offline: drop */ }
    this.busy = false;
    if (this.queue.length) void this.flush();
  }
}
const queue = new InputQueue();

const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Insert",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"]);

function BrowserPage() {
  const toast = useToast();
  const router = useRouter();
  const infoApi = useApi<Info>("/api/browser");
  const info = infoApi.data;
  const [live, setState] = useState<LiveState | null>(null);
  const state = live ?? info?.state ?? null;
  const [starting, setStarting] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [suggestions, setSuggestions] = useState<{ url: string; title: string; bookmark: boolean }[]>([]);
  const [side, setSide] = useState<Side>("ai");
  const [sideOpen, setSideOpen] = useState(true);
  const [annotating, setAnnotating] = useState(false);
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number; done: boolean } | null>(null);
  const [draftNote, setDraftNote] = useState("");
  const [draftColor, setDraftColor] = useState("amber");
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [hasFrame, setHasFrame] = useState(false);
  const [dialog, setDialog] = useState<{ kind: string; message: string; defaultValue: string } | null>(null);
  const [dialogText, setDialogText] = useState("");
  const [extDirty, setExtDirty] = useState(false);
  const [clearProfile, setClearProfile] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const lastMove = useRef(0);
  const wheel = useRef({ dx: 0, dy: 0, x: 0, y: 0, t: 0 as unknown as ReturnType<typeof setTimeout> | 0 });
  useEffect(() => {
    const on = (e: Event) => toast.error("The browser did not take that", String((e as CustomEvent).detail));
    window.addEventListener("scaper-browser-error", on);
    return () => window.removeEventListener("scaper-browser-error", on);
  }, [toast]);
  const send = (e: Ev) => queue.push(e);
  const load = infoApi.reload;

  const open = Boolean(state?.open);
  const active = state?.tabs.find((t) => t.id === state.activeId) ?? null;
  const activeUrl = active?.url ?? "";
  // The address bar follows the page unless you are typing in it.
  const [lastUrl, setLastUrl] = useState("");
  if (!editing && activeUrl !== lastUrl) { setLastUrl(activeUrl); setAddress(activeUrl === "about:blank" ? "" : activeUrl); }

  // Annotations of the page on screen.
  const notesApi = useApi<{ annotations: Annotation[] }>(open ? `/api/browser/annotations?page=${encodeURIComponent(activeUrl)}` : null);
  const notes = open ? notesApi.data?.annotations ?? [] : [];
  const loadNotes = notesApi.reload;

  // The live stream.
  useEffect(() => {
    if (!open) return;
    const es = new EventSource("/api/browser/stream");
    let lastScroll = "";
    es.addEventListener("frame", (m) => {
      const f = JSON.parse((m as MessageEvent).data) as Frame;
      if (img.current) img.current.src = `data:image/jpeg;base64,${f.data}`;
      const sc = `${Math.round(f.scrollX)},${Math.round(f.scrollY)}`;
      if (sc !== lastScroll) { lastScroll = sc; setScroll({ x: f.scrollX, y: f.scrollY }); }
      setHasFrame(true);
    });
    es.addEventListener("state", (m) => setState((JSON.parse((m as MessageEvent).data) as { state: LiveState }).state));
    es.addEventListener("dialog", (m) => { const d = JSON.parse((m as MessageEvent).data) as { kind: string; message: string; defaultValue: string }; setDialog(d); setDialogText(d.defaultValue); });
    es.addEventListener("notice", (m) => { const n = JSON.parse((m as MessageEvent).data) as { level: string; message: string }; (n.level === "warning" ? toast.error : toast.info)(n.message); });
    return () => es.close();
  }, [open, toast]);

  // The page is rendered at the size of the view, so the picture is never scaled.
  useEffect(() => {
    if (!open || !view.current) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e!.contentRect;
      if (t) clearTimeout(t);
      t = setTimeout(() => void api("/api/browser/action", { body: { action: "viewport", width: Math.max(320, Math.floor(width)), height: Math.max(240, Math.floor(height)) } }).catch(() => undefined), 250);
    });
    ro.observe(view.current);
    return () => { ro.disconnect(); if (t) clearTimeout(t); };
  }, [open]);

  const act = async (body: Record<string, unknown>) => {
    try { const r = await api<{ state: LiveState }>("/api/browser/action", { body }); setState(r.state); } catch (e) { toast.error("The browser could not do that", errorText(e)); }
  };
  const start = async (mode: "normal" | "incognito") => {
    setStarting(mode);
    try { const r = await api<{ state: LiveState }>("/api/browser", { body: { action: "open", mode } }); setState(r.state); setHasFrame(false); setExtDirty(false); void load(); }
    catch (e) { toast.error("The browser could not start", errorText(e)); } finally { setStarting(null); }
  };
  const close = async () => { await api("/api/browser", { body: { action: "close" } }).catch(() => undefined); setHasFrame(false); setState(null); void load(); };
  const restart = async () => { const mode = state?.mode ?? "normal"; await close(); await start(mode); };
  const go = (url: string) => { setEditing(false); setSuggestions([]); surface.current?.focus(); void act({ action: "navigate", url }); };

  useEffect(() => {
    if (!editing || address.trim().length < 2) return;
    const c = new AbortController();
    const t = setTimeout(() => void api<{ items: typeof suggestions }>(`/api/browser/suggest?q=${encodeURIComponent(address.trim())}`, { signal: c.signal }).then((r) => setSuggestions(r.items)).catch(() => undefined), 150);
    return () => { clearTimeout(t); c.abort(); };
  }, [address, editing]);

  // Mouse position in page pixels (the picture is drawn 1:1 with the page's viewport).
  const point = (e: { clientX: number; clientY: number }) => {
    const r = surface.current!.getBoundingClientRect();
    const vp = state!.viewport;
    return { x: Math.round(((e.clientX - r.left) / r.width) * vp.width), y: Math.round(((e.clientY - r.top) / r.height) * vp.height) };
  };
  const button = (b: number) => (b === 2 ? "right" : b === 1 ? "middle" : "left");

  const onMouseDown = (e: React.MouseEvent) => {
    surface.current?.focus();
    const p = point(e);
    if (annotating) { setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y, done: false }); return; }
    send({ type: "mouse", kind: "down", ...p, button: button(e.button) });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const p = point(e);
    if (annotating) { if (draft && !draft.done) setDraft({ ...draft, x1: p.x, y1: p.y }); return; }
    const now = performance.now();
    if (now - lastMove.current < 40 && e.buttons === 0) return;
    lastMove.current = now;
    send({ type: "mouse", kind: "move", ...p, button: "left" });
  };
  const onMouseUp = (e: React.MouseEvent) => {
    const p = point(e);
    if (annotating) {
      if (draft && !draft.done) {
        const d = { ...draft, x1: p.x, y1: p.y, done: true };
        if (Math.abs(d.x1 - d.x0) < 6 || Math.abs(d.y1 - d.y0) < 6) setDraft(null);
        else { setDraft(d); setDraftNote(""); }
      }
      return;
    }
    send({ type: "mouse", kind: "up", ...p, button: button(e.button) });
  };
  const onWheel = (e: React.WheelEvent) => {
    const p = point(e);
    const w = wheel.current;
    w.dx += e.deltaX; w.dy += e.deltaY; w.x = p.x; w.y = p.y;
    if (w.t) return;
    w.t = setTimeout(() => { send({ type: "wheel", x: w.x, y: w.y, dx: Math.round(w.dx), dy: Math.round(w.dy) }); w.dx = 0; w.dy = 0; w.t = 0; }, 30);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (annotating) { if (e.key === "Escape") { setAnnotating(false); setDraft(null); } return; }
    const mods = [e.altKey && "Alt", e.ctrlKey && "Control", e.metaKey && "Meta", e.shiftKey && "Shift"].filter(Boolean) as string[];
    // Paste comes from your own clipboard through the paste event.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
    e.preventDefault();
    if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) send({ type: "key", key: e.key === " " ? "Space" : e.key, modifiers: [] });
    else if (KEYS.has(e.key) || e.key.length === 1) send({ type: "key", key: e.key.length === 1 ? e.key.toLowerCase() : e.key, modifiers: mods });
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text/plain");
    if (text) { e.preventDefault(); send({ type: "text", text: text.slice(0, 2000) }); }
  };

  const saveDraft = async () => {
    if (!draft) return;
    const x = Math.min(draft.x0, draft.x1), y = Math.min(draft.y0, draft.y1);
    try {
      await api("/api/browser/annotations", { body: { x: x + scroll.x, y: y + scroll.y, w: Math.abs(draft.x1 - draft.x0), h: Math.abs(draft.y1 - draft.y0), note: draftNote, color: draftColor } });
      setDraft(null); void loadNotes(); setSide("notes"); setSideOpen(true);
    } catch (e) { toast.error("Could not save the annotation", errorText(e)); }
  };
  const bookmarked = info?.bookmarks.some((b) => b.url === activeUrl);
  const toggleBookmark = async () => {
    try {
      const hit = info?.bookmarks.find((b) => b.url === activeUrl);
      if (hit) await api(`/api/browser/bookmarks/${hit.id}`, { method: "DELETE" });
      else await api("/api/browser/bookmarks", { body: { url: activeUrl, title: active?.title ?? "" } });
      void load();
    } catch (e) { toast.error("Could not change the bookmark", errorText(e)); }
  };
  const wipeProfile = async () => {
    try { await api("/api/browser/profile", { method: "DELETE" }); toast.success("Profile cleared", "Cookies and sign-ins are gone. History and bookmarks stay."); setClearProfile(false); void load(); }
    catch (e) { toast.error("Could not clear the profile", errorText(e)); }
  };

  if (!info || !state) return <div className="skeleton h-[70vh] rounded-xl" />;

  if (!open) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 py-10">
        <div className="space-y-2 text-center">
          <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent"><AppWindow className="size-6" /></span>
          <h1 className="text-2xl font-semibold">Browser</h1>
          <p className="text-sm text-muted">A real browser inside Scaper, shown live. Browse as usual, draw boxes and notes on any page, and ask your AI about what you see or let it click and type for you while you watch.</p>
        </div>
        {info.settings.privateMode && <Callout tone="warning" icon={<EyeOff className="size-4 text-warning" />} title="Private mode is on">The browser opens in incognito: nothing is saved.</Callout>}
        <EngineChooser settings={info.settings} onChanged={() => void load()} />
        <div className="grid gap-3 sm:grid-cols-2">
          <button type="button" disabled={Boolean(starting) || info.settings.privateMode || (info.settings.engine === "firefox" && !info.settings.firefoxInstalled)} onClick={() => void start("normal")} className="space-y-1.5 rounded-2xl border border-border bg-surface p-5 text-left transition-colors hover:border-accent disabled:opacity-60">
            <span className="flex items-center gap-2 font-medium"><Globe className="size-4 text-accent" />{starting === "normal" ? "Starting…" : "Open the browser"}</span>
            <span className="block text-xs text-muted">Keeps your sign-ins, cookies, history and bookmarks on this computer{info.settings.engine === "chromium" ? `, with ${info.extensions.filter((x) => x.enabled).length || "no"} add-on${info.extensions.filter((x) => x.enabled).length === 1 ? "" : "s"}` : ""}.</span>
          </button>
          <button type="button" disabled={Boolean(starting) || (info.settings.engine === "firefox" && !info.settings.firefoxInstalled)} onClick={() => void start("incognito")} className="space-y-1.5 rounded-2xl border border-border bg-surface p-5 text-left transition-colors hover:border-accent disabled:opacity-60">
            <span className="flex items-center gap-2 font-medium"><EyeOff className="size-4 text-violet-500" />{starting === "incognito" ? "Starting…" : "Open incognito"}</span>
            <span className="block text-xs text-muted">A fresh profile in memory: no history, no cookies afterwards, no extensions. Everything goes when you close it.</span>
          </button>
        </div>
        <p className="text-center text-xs text-muted">Sites see a normal {ENGINE_NAME[info.settings.engine]} visit from this computer. Pages your AI opens still follow robots.txt and your site rules.</p>
      </div>
    );
  }

  const vp = state.viewport;
  const incognito = state.mode === "incognito";
  const box = draft ? { left: Math.min(draft.x0, draft.x1), top: Math.min(draft.y0, draft.y1), width: Math.abs(draft.x1 - draft.x0), height: Math.abs(draft.y1 - draft.y0) } : null;

  return (
    <div className="flex h-[calc(100dvh-5.5rem)] min-h-[480px] gap-2">
      <div className={`flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border ${incognito ? "border-violet-500/40" : "border-border"} bg-surface`}>
        {/* Tabs */}
        <div className={`flex items-end gap-1 overflow-x-auto px-2 pt-1.5 ${incognito ? "bg-violet-500/10" : "bg-surface-2/60"}`} role="tablist" aria-label="Tabs">
          {incognito && <Badge className="mb-1.5 mr-1 shrink-0" tone="neutral"><EyeOff className="size-3" />Incognito</Badge>}
          {state.tabs.map((t) => (
            <div key={t.id} role="tab" aria-selected={t.id === state.activeId}
              className={`group flex h-8 max-w-56 min-w-28 shrink-0 items-center gap-1.5 rounded-t-lg px-2.5 text-xs ${t.id === state.activeId ? "bg-surface font-medium" : "text-muted hover:bg-surface/60"}`}>
              <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => void act({ action: "switchTab", tabId: t.id })} title={t.url}>
                {t.loading ? <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" /> : <Globe className="size-3 shrink-0" />}
                <span className="truncate">{t.title || (t.url === "about:blank" ? "New tab" : t.url)}</span>
              </button>
              <button type="button" aria-label={`Close ${t.title || "tab"}`} className="rounded p-0.5 opacity-60 hover:bg-surface-2 hover:opacity-100" onClick={() => void act({ action: "closeTab", tabId: t.id })}><X className="size-3" /></button>
            </div>
          ))}
          <IconButton size="sm" label="New tab" className="mb-0.5 shrink-0" onClick={() => void act({ action: "newTab" })}><Plus className="size-4" /></IconButton>
        </div>
        {/* Toolbar */}
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <IconButton size="sm" label="Back" onClick={() => void act({ action: "back" })}><ArrowLeft className="size-4" /></IconButton>
          <IconButton size="sm" label="Forward" onClick={() => void act({ action: "forward" })}><ArrowRight className="size-4" /></IconButton>
          <IconButton size="sm" label={active?.loading ? "Stop" : "Reload"} onClick={() => void act({ action: active?.loading ? "stop" : "reload" })}>{active?.loading ? <X className="size-4" /> : <RotateCw className="size-4" />}</IconButton>
          <form className="relative min-w-0 flex-1" onSubmit={(e) => { e.preventDefault(); if (address.trim()) go(address); }}>
            <Input aria-label="Address" className="h-8 w-full pr-8 text-sm" value={address} placeholder="Search or type a web address"
              onFocus={(e) => { setEditing(true); e.currentTarget.select(); }} onBlur={() => setTimeout(() => { setEditing(false); setSuggestions([]); }, 150)}
              onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { setEditing(false); setAddress(activeUrl); e.currentTarget.blur(); } }} />
            {/^https?:/.test(activeUrl) && <button type="button" aria-label={bookmarked ? "Remove bookmark" : "Bookmark this page"} className="absolute top-1/2 right-2 -translate-y-1/2 text-muted hover:text-warning" onClick={() => void toggleBookmark()}>
              <Star className={`size-4 ${bookmarked ? "fill-warning text-warning" : ""}`} />
            </button>}
            {editing && suggestions.length > 0 && (
              <ul className="absolute inset-x-0 top-9 z-30 overflow-hidden rounded-xl border border-border bg-surface shadow-pop" role="listbox">
                {suggestions.map((s) => (
                  <li key={s.url}><button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2" onMouseDown={(e) => { e.preventDefault(); go(s.url); }}>
                    {s.bookmark ? <Star className="size-3.5 shrink-0 text-warning" /> : <History className="size-3.5 shrink-0 text-muted" />}
                    <span className="min-w-0 truncate">{s.title || s.url}</span><span className="ml-auto max-w-[45%] truncate text-xs text-muted">{s.url}</span>
                  </button></li>
                ))}
              </ul>
            )}
          </form>
          <Button size="sm" variant={annotating ? "primary" : "ghost"} icon={<SquareDashedMousePointer className="size-4" />} aria-pressed={annotating} onClick={() => { setAnnotating((v) => !v); setDraft(null); surface.current?.focus(); }}>
            <span className="hidden md:inline">{annotating ? "Drawing…" : "Annotate"}</span>
          </Button>
          <IconButton size="sm" label="Save a screenshot" onClick={() => { const a = document.createElement("a"); a.href = "/api/browser/screenshot?download=1"; a.click(); }}><Camera className="size-4" /></IconButton>
          <Menu label="Browser menu" trigger={(p) => <IconButton size="sm" label="Browser menu" {...p}><MoreHorizontal className="size-4" /></IconButton>} items={[
            { label: "New tab", icon: <Plus />, onSelect: () => void act({ action: "newTab" }) },
            { label: incognito ? "Switch to the normal profile" : "Switch to incognito", icon: <EyeOff />, onSelect: () => void (async () => { await close(); await start(incognito ? "normal" : "incognito"); })() },
            ...(/^https?:/.test(activeUrl) ? [
              { label: "Find files on this page", icon: <FileSearch />, onSelect: () => router.push(`/downloads?findUrl=${encodeURIComponent(activeUrl)}`) },
              { label: "Open in my own browser", icon: <ExternalLink />, onSelect: () => window.open(activeUrl, "_blank", "noopener") },
            ] : []),
            { label: "History", icon: <History />, onSelect: () => { setSide("history"); setSideOpen(true); } },
            { label: "Bookmarks", icon: <BookmarkIcon />, onSelect: () => { setSide("bookmarks"); setSideOpen(true); } },
            { label: "Extensions", icon: <Puzzle />, onSelect: () => { setSide("extensions"); setSideOpen(true); } },
            { separator: true as const },
            { label: "Restart the browser", icon: <RotateCw />, onSelect: () => void restart() },
            ...(!incognito ? [{ label: "Sign out everywhere (clear profile)", icon: <X />, onSelect: () => setClearProfile(true) }] : []),
            { label: "Close the browser", icon: <Power />, danger: true, onSelect: () => void close() },
          ]} />
          <IconButton size="sm" label={sideOpen ? "Hide the side panel" : "Show the side panel"} onClick={() => setSideOpen((v) => !v)}>{sideOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}</IconButton>
        </div>
        {state.aiActing && <p className="flex items-center gap-2 bg-accent-soft px-3 py-1 text-xs text-accent" role="status"><Sparkles className="size-3.5" />Your AI is working in this tab…</p>}
        {annotating && <p className="bg-warning/10 px-3 py-1 text-xs" role="status">Drag a box over what you mean, then write a note. Press Esc or Annotate again to stop.</p>}
        {/* The page */}
        {active?.loading && <div className="h-0.5 overflow-hidden bg-accent-soft" role="progressbar" aria-label="Loading"><div className="h-full w-1/3 animate-[indeterminate_1.2s_ease-in-out_infinite] bg-accent" /></div>}
        {active?.problem && (
          <div className={`flex flex-wrap items-start gap-3 border-b px-3 py-2 text-sm ${active.problem.kind === "blocked" || active.problem.kind === "http" ? "border-warning/30 bg-warning/10" : "border-danger/30 bg-danger/10"}`} role="alert">
            <AlertTriangle className={`mt-0.5 size-4 shrink-0 ${active.problem.kind === "blocked" || active.problem.kind === "http" ? "text-warning" : "text-danger"}`} />
            <div className="min-w-0 flex-1"><p className="font-medium">{active.problem.title}</p><p className="text-xs text-muted">{active.problem.detail}</p></div>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="secondary" icon={<RotateCw className="size-4" />} onClick={() => void act({ action: "reload" })}>Reload</Button>
              {/^https?:/.test(active.url) && <Button size="sm" variant="ghost" icon={<ExternalLink className="size-4" />} onClick={() => window.open(active.url, "_blank", "noopener")}>My browser</Button>}
              <Link href="/settings?tab=data"><Button size="sm" variant="ghost" icon={<SettingsIcon className="size-4" />}>Browser settings</Button></Link>
            </div>
          </div>
        )}
        <div ref={view} className="relative min-h-0 flex-1 overflow-hidden bg-white">
          <div ref={surface} tabIndex={0} role="application" aria-label={`Web page: ${active?.title ?? ""}`}
            className={`absolute inset-0 outline-none ${annotating ? "cursor-crosshair" : "cursor-default"}`}
            onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onWheel={onWheel} onKeyDown={onKeyDown} onPaste={onPaste}
            onContextMenu={(e) => e.preventDefault()} onDoubleClick={(e) => e.preventDefault()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img ref={img} alt="" draggable={false} className="pointer-events-none size-full object-fill select-none" />
            {!hasFrame && <div className="absolute inset-0 grid place-items-center text-sm text-muted">Loading the page…</div>}
            {notes.map((a, i) => {
              const left = ((a.x - scroll.x) / vp.width) * 100, top = ((a.y - scroll.y) / vp.height) * 100;
              if (top > 100 || top + (a.h / vp.height) * 100 < 0) return null;
              const c = NOTE_COLORS[a.color] ?? NOTE_COLORS.amber;
              return (
                <div key={a.id} className="pointer-events-none absolute rounded-md border-2" style={{ left: `${left}%`, top: `${top}%`, width: `${(a.w / vp.width) * 100}%`, height: `${(a.h / vp.height) * 100}%`, borderColor: c, background: `${c}1a` }}>
                  <span className="absolute -top-2.5 -left-2.5 grid size-5 place-items-center rounded-full text-[11px] font-semibold text-white shadow" style={{ background: c }}>{i + 1}</span>
                  {a.note && <span className="absolute top-full left-0 mt-1 max-w-64 truncate rounded bg-black/75 px-1.5 py-0.5 text-[11px] text-white">{a.note}</span>}
                </div>
              );
            })}
            {box && (
              <div className="absolute rounded-md border-2 border-dashed" style={{ left: `${(box.left / vp.width) * 100}%`, top: `${(box.top / vp.height) * 100}%`, width: `${(box.width / vp.width) * 100}%`, height: `${(box.height / vp.height) * 100}%`, borderColor: NOTE_COLORS[draftColor], background: `${NOTE_COLORS[draftColor]}22` }}>
                {draft?.done && (
                  <form className="absolute top-full left-0 z-20 mt-2 w-72 space-y-2 rounded-xl border border-border bg-surface p-3 text-text shadow-pop" onMouseDown={(e) => e.stopPropagation()} onMouseUp={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
                    onSubmit={(e) => { e.preventDefault(); void saveDraft(); }}>
                    <Input aria-label="Note for your AI" autoFocus className="h-9 text-sm" value={draftNote} onChange={(e) => setDraftNote(e.target.value)} placeholder="e.g. Scrape these prices every day" />
                    <div className="flex items-center gap-1.5">
                      {Object.entries(NOTE_COLORS).map(([k, c]) => <button key={k} type="button" aria-label={k} aria-pressed={draftColor === k} className={`size-5 rounded-full ring-offset-2 ring-offset-surface ${draftColor === k ? "ring-2 ring-text" : ""}`} style={{ background: c }} onClick={() => setDraftColor(k)} />)}
                      <span className="flex-1" />
                      <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
                      <Button size="sm" type="submit" icon={<StickyNote className="size-4" />}>Save</Button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {sideOpen && (
        <aside className="hidden w-[400px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-surface lg:flex" aria-label="Browser side panel">
          <Tabs className="px-2 pt-1" size="sm" value={side} onChange={setSide} tabs={[
            { value: "ai", label: "AI" },
            { value: "notes", label: "Notes", count: notes.length || undefined },
            { value: "history", label: "History" },
            { value: "bookmarks", label: "Saved" },
            { value: "extensions", label: "Add-ons" },
          ]} />
          <div className="min-h-0 flex-1">
            {/* The chat stays mounted so switching tabs keeps it. */}
            <div className={side === "ai" ? "h-full" : "hidden"}><AskPanel hasNotes={notes.length} open={open} /></div>
            {side === "notes" && <NotesPanel notes={notes} onChanged={() => void loadNotes()} onAsk={() => setSide("ai")} url={activeUrl} incognito={incognito} />}
            {side === "history" && <HistoryPanel onOpen={go} enabled={info.settings.history && !incognito} />}
            {side === "bookmarks" && <BookmarksPanel items={info.bookmarks} onOpen={go} onChanged={() => void load()} />}
            {side === "extensions" && <ExtensionsPanel items={info.extensions} incognito={incognito} needsRestart={extDirty && !incognito}
              onChanged={() => { setExtDirty(true); void load(); }} onRestart={() => void restart()} onOpenPage={(url) => void act({ action: "newTab", url })} />}
          </div>
        </aside>
      )}

      <Dialog open={Boolean(dialog)} onClose={() => { setDialog(null); void act({ action: "dialog", accept: false }); }} title={dialog?.kind === "confirm" ? "The page asks" : dialog?.kind === "prompt" ? "The page asks for text" : "Message from the page"}
        footer={<>
          {dialog?.kind !== "alert" && <Button variant="ghost" onClick={() => { setDialog(null); void act({ action: "dialog", accept: false }); }}>Cancel</Button>}
          <Button onClick={() => { setDialog(null); void act({ action: "dialog", accept: true, text: dialog?.kind === "prompt" ? dialogText : undefined }); }}>OK</Button>
        </>}>
        <p className="text-sm whitespace-pre-wrap">{dialog?.message}</p>
        {dialog?.kind === "prompt" && <Input aria-label="Answer" className="mt-3" value={dialogText} onChange={(e) => setDialogText(e.target.value)} />}
      </Dialog>
      <ConfirmDialog open={clearProfile} onCancel={() => setClearProfile(false)} onConfirm={() => void wipeProfile()} confirmLabel="Clear profile" title="Sign out everywhere?"
        body="Closes the browser and deletes its profile: cookies, sign-ins and site data. History, bookmarks and extensions stay." />
    </div>
  );
}

export default function Page() {
  return <Suspense><BrowserPage /></Suspense>;
}
