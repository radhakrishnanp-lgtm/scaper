"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, CornerDownLeft, FilePlus2, ListChecks, Moon, Plus, Radar, ScanSearch, Search, Tag } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { ALL_NAV } from "./nav";
import { Kbd } from "./ui";

type Result = { type: string; id: string; title: string; subtitle?: string; href: string };
type Command = { id: string; group: string; label: string; hint?: string; icon: React.ReactNode; run: () => void; keywords?: string };

const TYPE_LABEL: Record<string, string> = { task: "Task", watcher: "Watcher", product: "Product", deal_search: "Deal search" };

const looksLikeUrl = (s: string) => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(s.trim());

/**
 * Ctrl/⌘ + K: jump anywhere, search everything you saved, or start an action with
 * the URL you typed ("scrape this", "watch this", "track this price").
 */
export function CommandPalette({ open, onClose, toggleTheme }: { open: boolean; onClose: () => void; toggleTheme: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Fresh palette each time it opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQ(""); setResults([]); setIndex(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open || q.trim().length < 2) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api<{ results: Result[] }>(`/api/search?q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal }).then((d) => setResults(d.results)).catch(() => undefined);
    }, 150);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q, open]);

  const go = (href: string) => { onClose(); router.push(href); };

  const commands = useMemo<Command[]>(() => {
    const text = q.trim();
    const url = looksLikeUrl(text) ? (/^https?:\/\//i.test(text) ? text : `https://${text}`) : null;
    const out: Command[] = [];
    if (url) {
      out.push(
        { id: "u-scrape", group: "With this URL", label: `Scrape ${url}`, icon: <ScanSearch />, run: () => go(`/scrape?url=${encodeURIComponent(url)}`) },
        { id: "u-watch", group: "With this URL", label: `Watch ${url} for changes`, icon: <Radar />, run: () => go(`/watchers/new?url=${encodeURIComponent(url)}`) },
        { id: "u-task", group: "With this URL", label: "New task for this URL", icon: <FilePlus2 />, run: () => go(`/tasks/new?url=${encodeURIComponent(url)}`) },
        { id: "u-price", group: "With this URL", label: "Track this product's price", icon: <Tag />, run: () => go(`/deals?track=${encodeURIComponent(url)}`) },
      );
    }
    out.push(
      { id: "new-task", group: "Create", label: "New task", hint: "multi-page scraper", icon: <ListChecks />, run: () => go("/tasks/new"), keywords: "create recipe crawler" },
      { id: "new-watch", group: "Create", label: "New watcher", icon: <Plus />, run: () => go("/watchers/new"), keywords: "create monitor" },
      { id: "new-price", group: "Create", label: "Track a product", icon: <Tag />, run: () => go("/deals?track="), keywords: "price amazon" },
      { id: "read-all", group: "Actions", label: "Mark all alerts as read", icon: <CheckCheck />, run: () => { onClose(); void api("/api/notifications", { body: { action: "read", ids: "all" } }).then(() => window.dispatchEvent(new Event("scaper:live"))); } },
      { id: "theme", group: "Actions", label: "Toggle dark mode", icon: <Moon />, run: () => { toggleTheme(); onClose(); }, keywords: "light theme" },
      ...ALL_NAV.map((n) => ({ id: `nav-${n.href}`, group: "Go to", label: n.label, icon: <n.icon />, run: () => go(n.href), keywords: n.keywords })),
    );
    if (!text || url) return out;
    const needle = text.toLowerCase();
    return out.filter((c) => `${c.label} ${c.keywords ?? ""} ${c.hint ?? ""}`.toLowerCase().includes(needle));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- go/onClose are stable enough; q drives the list
  }, [q]);

  const all: Command[] = useMemo(() => [
    ...(q.trim().length >= 2 ? results : []).map((r) => ({ id: `r-${r.type}-${r.id}`, group: "Saved", label: r.title, hint: TYPE_LABEL[r.type] ?? r.type, icon: <Search />, run: () => go(r.href), keywords: r.subtitle })),
    ...commands,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [results, commands, q]);

  useEffect(() => {
    // Keep the highlight on a real row when the list changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIndex((i) => Math.min(i, Math.max(0, all.length - 1)));
  }, [all.length]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;
  const groups = [...new Set(all.map((c) => c.group))];
  let n = -1;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-[2px]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="pop-in w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-surface shadow-pop">
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="size-5 text-muted" aria-hidden />
          <input
            ref={input}
            value={q}
            onChange={(e) => { setQ(e.target.value); setIndex(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(all.length - 1, i + 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
              if (e.key === "Enter") { e.preventDefault(); all[index]?.run(); }
              if (e.key === "Escape") onClose();
            }}
            placeholder="Search, jump to a page, or paste a URL…"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={all[index] ? `cmd-${all[index]!.id}` : undefined}
            className="h-14 flex-1 bg-transparent text-base outline-none placeholder:text-muted/70"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div ref={list} id="palette-list" role="listbox" className="scroll-thin max-h-[55vh] overflow-y-auto p-2">
          {!all.length && <p className="px-3 py-8 text-center text-sm text-muted">Nothing matches “{q}”.</p>}
          {groups.map((g) => (
            <div key={g} className="mb-1">
              <div className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">{g}</div>
              {all.filter((c) => c.group === g).map((c) => {
                n++;
                const i = n;
                return (
                  <button
                    key={c.id}
                    id={`cmd-${c.id}`}
                    data-index={i}
                    role="option"
                    aria-selected={i === index}
                    onMouseMove={() => setIndex(i)}
                    onClick={() => c.run()}
                    className={cn("flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm", i === index ? "bg-accent-soft text-text" : "text-text")}
                  >
                    <span className={cn("[&>svg]:size-4", i === index ? "text-accent" : "text-muted")}>{c.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{c.label}</span>
                    {c.hint && <span className="text-xs text-muted">{c.hint}</span>}
                    {i === index && <CornerDownLeft className="size-3.5 text-muted" aria-hidden />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-xs text-muted">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
          <span className="ml-auto">Tip: paste a URL to scrape, watch or track it</span>
        </div>
      </div>
    </div>
  );
}
