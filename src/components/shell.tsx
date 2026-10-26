"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Bell, BellRing, CheckCheck, ChevronsLeft, ChevronsRight, EyeOff, Loader2, LogOut, Menu as MenuIcon, Moon, Search, Square, Sun, X,
} from "lucide-react";
import type { Job } from "@/server/repo/jobs";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { CommandPalette } from "./command-palette";
import { LiveProvider, useLive } from "./live";
import { Popover } from "./menu";
import { NAV, isActive } from "./nav";
import { useToast } from "./toast";
import { IconButton, Kbd, Progress } from "./ui";

/** A reminder in the top bar while private mode is on in Settings → Privacy. */
function PrivateIndicator() {
  const path = usePathname();
  const [on, setOn] = useState(false);
  useEffect(() => {
    let stop = false;
    api<{ privateMode: boolean }>("/api/agent").then((r) => { if (!stop) setOn(r.privateMode); }, () => undefined);
    return () => { stop = true; };
  }, [path]);
  if (!on) return null;
  return (
    <Link prefetch={false} href="/settings?tab=privacy" title="Quick scrapes, AI extraction, category scrapes and agent chats are kept in memory only" className="mr-1 inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-xs font-medium text-muted hover:text-text">
      <EyeOff className="size-3.5" aria-hidden /><span className="hidden sm:inline">Private mode</span><span className="sr-only sm:hidden">Private mode is on</span>
    </Link>
  );
}

function Logo({ compact }: { compact?: boolean }) {
  return (
    <Link prefetch={false} href="/" className="flex items-center gap-2.5 px-2 font-semibold tracking-tight" aria-label="Scaper home">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg">
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /><path d="M8 11h6M11 8v6" />
        </svg>
      </span>
      {!compact && <span className="text-lg">Scaper</span>}
    </Link>
  );
}

function useStoredFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(initial);
  useEffect(() => {
    // Read the saved preference after mount (localStorage is not available during server rendering).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    try { const s = localStorage.getItem(key); if (s !== null) setV(s === "1"); } catch { /* private mode */ }
  }, [key]);
  const set = (next: boolean) => { setV(next); try { localStorage.setItem(key, next ? "1" : "0"); } catch { /* private mode */ } };
  return [v, set];
}

function useTheme() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    // Read the class the inline script set before hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDark(document.documentElement.classList.contains("dark"));
  }, []);
  const toggle = useCallback(() => {
    setDark((d) => {
      const next = !d;
      document.documentElement.classList.toggle("dark", next);
      try { localStorage.setItem("scaper-theme", next ? "dark" : "light"); } catch { /* private mode */ }
      return next;
    });
  }, []);
  return { dark, toggle };
}

const KIND_LABEL: Record<string, string> = { task: "Task", scrape: "Scrape", watch: "Check", product: "Price", deal_search: "Deals", backup: "Backup", bulk_products: "Import" };

function JobsIndicator() {
  const { active, counts, refreshJobs } = useLive();
  const toast = useToast();
  const running = counts?.running ?? 0;
  const queued = counts?.queued ?? 0;
  return (
    <Popover
      label="Running jobs"
      trigger={(p) => (
        <button
          {...p}
          type="button"
          className={cn("flex h-10 items-center gap-2 rounded-lg px-2.5 text-sm transition-colors hover:bg-surface-2", running ? "text-accent" : "text-muted")}
          aria-label={`${running} running, ${queued} queued`}
          title="Running jobs"
        >
          {running ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <span className="size-2 rounded-full bg-success" aria-hidden />}
          <span className="hidden tabular-nums sm:inline">{running ? `${running} running` : "Idle"}{queued ? ` · ${queued} queued` : ""}</span>
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-semibold">Jobs</p>
            <span className="text-xs text-muted tabular-nums">{running} running · {queued} queued</span>
          </div>
          <ul className="scroll-thin max-h-80 divide-y divide-border overflow-y-auto">
            {!active.length && <li className="px-4 py-6 text-center text-sm text-muted">Nothing is running. Scheduled checks start on their own.</li>}
            {active.map((j: Job) => {
              const p = j.progress ?? {};
              return (
                <li key={j.id} className="space-y-1.5 px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-surface-2 px-1.5 text-[11px] font-medium text-muted">{KIND_LABEL[j.kind] ?? j.kind}</span>
                    <Link prefetch={false} href={`/runs/${j.id}`} onClick={close} className="min-w-0 flex-1 truncate text-sm hover:text-accent">{j.title}</Link>
                    <IconButton
                      size="sm"
                      label="Cancel job"
                      onClick={() => api(`/api/jobs/${j.id}/cancel`, { body: {} }).then(() => { toast.info("Cancelling", j.title); refreshJobs(); }).catch((e: Error) => toast.error("Could not cancel", e.message))}
                    >
                      <Square className="size-3.5" />
                    </IconButton>
                  </div>
                  {j.status === "running"
                    ? <Progress label={`Progress of ${j.title}`} value={p.total ? p.done ?? 0 : null} max={p.total ?? 100} />
                    : <p className="text-xs text-muted">Queued {timeAgo(j.created_at)}{j.attempts ? ` · retry ${j.attempts + 1}` : ""}</p>}
                  {p.label && j.status === "running" && <p className="truncate text-xs text-muted">{p.label}{p.rows !== undefined ? ` · ${p.rows} rows` : ""}</p>}
                </li>
              );
            })}
          </ul>
          <Link prefetch={false} href="/runs" onClick={close} className="block border-t border-border px-4 py-2.5 text-center text-sm font-medium text-accent hover:bg-surface-2">Open Runs</Link>
        </div>
      )}
    </Popover>
  );
}

type Notif = { id: string; title: string; body: string; kind: string; read_at: string | null; created_at: string; url: string | null; watcher_id: string | null };

function AlertsPopover() {
  const { unread, setUnread } = useLive();
  const [items, setItems] = useState<Notif[] | null>(null);
  const [perm, setPerm] = useState<string>("granted");
  const load = () => {
    if ("Notification" in window) setPerm(Notification.permission);
    api<{ items: Notif[]; unread: number }>("/api/notifications?limit=8").then((d) => { setItems(d.items); setUnread(d.unread); }).catch(() => setItems([]));
  };
  return (
    <Popover
      label="Recent alerts"
      trigger={(p) => (
        <button
          {...p}
          onClick={() => { p.onClick(); if (!p["aria-expanded"]) load(); }}
          type="button"
          className="relative flex size-10 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
          aria-label={`Alerts${unread ? `, ${unread} unread` : ""}`}
          title="Alerts"
        >
          <Bell className="size-5" />
          {unread > 0 && <span className="absolute top-1.5 right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-fg tabular-nums">{unread > 99 ? "99+" : unread}</span>}
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-semibold">Alerts</p>
            <button
              className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline disabled:opacity-40"
              disabled={!unread}
              onClick={() => api<{ unread: number }>("/api/notifications", { body: { action: "read", ids: "all" } }).then((d) => { setUnread(d.unread); load(); window.dispatchEvent(new Event("scaper:live")); })}
            >
              <CheckCheck className="size-3.5" /> Mark all read
            </button>
          </div>
          {perm === "default" && (
            <button
              className="flex w-full items-center gap-2 border-b border-border bg-accent-soft/40 px-4 py-2.5 text-left text-sm hover:bg-accent-soft/70"
              onClick={() => Notification.requestPermission().then(setPerm)}
            >
              <BellRing className="size-4 text-accent" /> Turn on desktop notifications
            </button>
          )}
          <ul className="scroll-thin max-h-96 divide-y divide-border overflow-y-auto">
            {items === null && <li className="p-4"><div className="skeleton h-10 rounded" /></li>}
            {items?.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">No alerts yet.</li>}
            {items?.map((n) => (
              <li key={n.id}>
                <Link prefetch={false}
                  href={n.watcher_id ? `/watchers/${n.watcher_id}` : "/notifications"}
                  onClick={close}
                  className="flex gap-3 px-4 py-2.5 hover:bg-surface-2"
                >
                  <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.read_at ? "bg-transparent" : "bg-accent")} aria-label={n.read_at ? undefined : "Unread"} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{n.title}</span>
                    <span className="line-clamp-2 text-xs text-muted">{n.body}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted">{timeAgo(n.created_at)}</span>
                </Link>
              </li>
            ))}
          </ul>
          <Link prefetch={false} href="/notifications" onClick={close} className="block border-t border-border px-4 py-2.5 text-center text-sm font-medium text-accent hover:bg-surface-2">All alerts</Link>
        </div>
      )}
    </Popover>
  );
}

function SideNav({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const { unread, counts, inbox } = useLive();
  return (
    <nav aria-label="Main" className="flex flex-col gap-4">
      {NAV.map((g) => (
        <div key={g.label}>
          {!collapsed && <div className="px-3 pb-1 text-[11px] font-semibold tracking-wide text-muted/80 uppercase">{g.label}</div>}
          <div className="flex flex-col gap-0.5">
            {g.items.map((item) => {
              const on = isActive(item, pathname);
              const badge = item.href === "/notifications" && unread ? unread : item.href === "/runs" && counts?.running ? counts.running : item.href === "/changes" ? inbox : 0;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch={false}
                  onClick={onNavigate}
                  title={collapsed ? item.label : undefined}
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "relative flex h-10 items-center gap-3 rounded-lg text-sm font-medium transition-colors",
                    collapsed ? "justify-center px-0" : "px-3",
                    on ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
                  )}
                >
                  <item.icon className="size-[18px] shrink-0" aria-hidden />
                  {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
                  {badge > 0 && (collapsed
                    ? <span className="absolute top-1.5 right-2 size-2 rounded-full bg-accent" aria-label={`${badge}`} />
                    : <span className="rounded-full bg-accent px-1.5 text-[11px] leading-5 font-semibold text-accent-fg tabular-nums">{badge > 99 ? "99+" : badge}</span>)}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

function ShellInner({ children, passwordProtected }: { children: ReactNode; passwordProtected: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const { dark, toggle } = useTheme();
  const { connected } = useLive();
  const [collapsed, setCollapsed] = useStoredFlag("scaper-nav-collapsed", false);
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);

  useEffect(() => {
    const go = (e: Event) => router.push((e as CustomEvent<string>).detail);
    window.addEventListener("scaper:navigate", go);
    return () => window.removeEventListener("scaper:navigate", go);
  }, [router]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setPalette((p) => !p); }
      else if (e.key === "/" && !typing) { e.preventDefault(); setPalette(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    // Close the mobile drawer after navigating.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrawer(false);
  }, [pathname]);

  const logout = () => api("/api/auth/logout", { method: "POST", body: {} }).finally(() => {
    // A full reload on logout drops all client state, so a router push is not enough here.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/login";
  });

  const footer = (compact: boolean) => (
    <div className={cn("flex gap-1 border-t border-border pt-3", compact ? "flex-col items-center" : "items-center")}>
      <span className={cn("flex items-center gap-2 text-xs text-muted", compact ? "py-1" : "flex-1 px-3")} title={connected ? "Live updates connected" : "Reconnecting to live updates"}>
        <span className={cn("size-2 rounded-full", connected ? "bg-success" : "bg-warning")} aria-hidden />
        {!compact && (connected ? "Live" : "Reconnecting")}
      </span>
      <IconButton label={dark ? "Switch to light mode" : "Switch to dark mode"} onClick={toggle}>{dark ? <Sun className="size-4" /> : <Moon className="size-4" />}</IconButton>
      {passwordProtected && <IconButton label="Log out" onClick={logout}><LogOut className="size-4" /></IconButton>}
    </div>
  );

  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>

      {/* Desktop sidebar: fixed, so it always fills the full height. */}
      <aside className={cn("fixed inset-y-0 left-0 z-30 hidden flex-col gap-5 border-r border-border bg-surface py-4 transition-[width] duration-200 lg:flex", collapsed ? "w-[68px] px-2" : "w-[248px] px-3")}>
        <div className={cn("flex items-center", collapsed ? "justify-center" : "justify-between")}>
          <Logo compact={collapsed} />
          {!collapsed && <IconButton size="sm" label="Collapse sidebar" onClick={() => setCollapsed(true)}><ChevronsLeft className="size-4" /></IconButton>}
        </div>
        {collapsed && <IconButton label="Expand sidebar" className="mx-auto" onClick={() => setCollapsed(false)}><ChevronsRight className="size-4" /></IconButton>}
        <div className="scroll-thin -mx-1 flex-1 overflow-y-auto px-1"><SideNav collapsed={collapsed} /></div>
        {footer(collapsed)}
      </aside>

      <div className={cn("transition-[padding] duration-200", collapsed ? "lg:pl-[68px]" : "lg:pl-[248px]")}>
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-bg/85 px-3 backdrop-blur sm:px-4 lg:px-6">
          <IconButton label="Open menu" className="lg:hidden" onClick={() => setDrawer(true)} aria-expanded={drawer}><MenuIcon className="size-5" /></IconButton>
          <div className="lg:hidden"><Logo compact /></div>
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="ml-1 flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm text-muted transition-colors hover:border-muted/50 sm:max-w-md"
            aria-label="Search or jump to (Ctrl+K)"
          >
            <Search className="size-4 shrink-0" />
            <span className="truncate">Search, jump to, or paste a URL…</span>
            <span className="ml-auto hidden items-center gap-1 sm:flex"><Kbd>Ctrl</Kbd><Kbd>K</Kbd></span>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <PrivateIndicator />
            <JobsIndicator />
            <AlertsPopover />
          </div>
        </header>

        <main id="main" className={`mx-auto w-full min-w-0 ${pathname.startsWith("/browser") ? "max-w-none px-2 py-2 sm:px-3" : "max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8"}`}>{children}</main>
      </div>

      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col gap-5 bg-surface px-3 py-4 shadow-pop">
            <div className="flex items-center justify-between"><Logo /><IconButton label="Close menu" onClick={() => setDrawer(false)}><X className="size-5" /></IconButton></div>
            <div className="flex-1 overflow-y-auto"><SideNav collapsed={false} onNavigate={() => setDrawer(false)} /></div>
            {footer(false)}
          </div>
        </div>
      )}

      <CommandPalette open={palette} onClose={() => setPalette(false)} toggleTheme={toggle} />
    </div>
  );
}

export function Shell(props: { children: ReactNode; passwordProtected: boolean }) {
  // The login page has no session yet, so it gets no live connection or app chrome.
  if (usePathname() === "/login") return <>{props.children}</>;
  return (
    <LiveProvider>
      <ShellInner {...props} />
    </LiveProvider>
  );
}
