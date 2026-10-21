"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bell, Bot, History, LayoutDashboard, LogOut, Menu, Moon, Radar, ScanSearch, Settings, Sun, Tag, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { useToast } from "./toast";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/scrape", label: "Scrape", icon: ScanSearch },
  { href: "/watchers", label: "Watchers", icon: Radar },
  { href: "/deals", label: "Deals", icon: Tag },
  { href: "/agent", label: "Agent", icon: Bot },
  { href: "/history", label: "History", icon: History },
  { href: "/notifications", label: "Alerts", icon: Bell },
  { href: "/settings", label: "Settings", icon: Settings },
];

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-2 font-semibold tracking-tight">
      <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-fg">
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /><path d="M8 11h6M11 8v6" />
        </svg>
      </span>
      <span className="text-lg">Scaper</span>
    </Link>
  );
}

function useTheme() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    // Read the class the inline script set before hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDark(document.documentElement.classList.contains("dark"));
  }, []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("scaper-theme", next ? "dark" : "light"); } catch { /* private mode */ }
  };
  return { dark, toggle };
}

/** Live updates: new alerts become toasts and (when allowed) desktop notifications; pages refresh their data. */
function useLiveEvents(onUnread: (n: number) => void) {
  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; });
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const refreshUnread = () => api<{ unread: number }>("/api/notifications?limit=1").then((d) => onUnread(d.unread)).catch(() => undefined);
    const connect = () => {
      es = new EventSource("/api/notifications/stream");
      es.onmessage = (msg) => {
        const e = JSON.parse(msg.data) as { type: string; title?: string; body?: string; url?: string | null; desktop?: boolean };
        if (e.type === "hello") return;
        if (e.type === "notification") {
          void refreshUnread();
          toastRef.current.info(e.title ?? "Alert", e.body?.split("\n")[0]);
          if (e.desktop && "Notification" in window && Notification.permission === "granted") {
            const n = new Notification(e.title ?? "Scaper", { body: e.body?.slice(0, 200), tag: e.title });
            n.onclick = () => { window.focus(); window.dispatchEvent(new CustomEvent("scaper:navigate", { detail: "/notifications" })); };
          }
        }
        clearTimeout(refresh);
        refresh = setTimeout(() => window.dispatchEvent(new Event("scaper:live")), 400);
      };
      es.onerror = () => { es?.close(); retry = setTimeout(connect, 5000); };
    };
    connect();
    void refreshUnread();
    return () => { es?.close(); clearTimeout(retry); clearTimeout(refresh); };
  }, [onUnread]);
}

export function Shell({ children, passwordProtected }: { children: ReactNode; passwordProtected: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    const go = (e: Event) => router.push((e as CustomEvent<string>).detail);
    window.addEventListener("scaper:navigate", go);
    return () => window.removeEventListener("scaper:navigate", go);
  }, [router]);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const { dark, toggle } = useTheme();
  useLiveEvents(setUnread);
  useEffect(() => {
    // Close the mobile drawer after navigating.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(false);
  }, [pathname]);

  if (pathname === "/login") return <>{children}</>;

  const active = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          aria-current={active(href) ? "page" : undefined}
          className={cn(
            "flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
            active(href) ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
          )}
        >
          <Icon className="size-[18px]" aria-hidden />
          <span className="flex-1">{label}</span>
          {href === "/notifications" && unread > 0 && (
            <span className="rounded-full bg-accent px-1.5 text-xs leading-5 font-semibold text-accent-fg tabular-nums">{unread > 99 ? "99+" : unread}</span>
          )}
        </Link>
      ))}
    </nav>
  );
  const footer = (
    <div className="flex items-center gap-1 border-t border-border pt-3">
      <button onClick={toggle} className="flex h-10 flex-1 items-center gap-2 rounded-lg px-3 text-sm text-muted hover:bg-surface-2 hover:text-text" aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>
        {dark ? <Sun className="size-4" /> : <Moon className="size-4" />} {dark ? "Light mode" : "Dark mode"}
      </button>
      {passwordProtected && (
        <button
          // A full reload on logout drops all client state, so a router push is not enough here.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          onClick={() => api("/api/auth/logout", { method: "POST", body: {} }).finally(() => { window.location.href = "/login"; })}
          className="flex size-10 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text" aria-label="Log out"
        >
          <LogOut className="size-4" />
        </button>
      )}
    </div>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[248px_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>
      <aside className="sticky top-0 hidden h-dvh flex-col gap-6 border-r border-border bg-surface px-3 py-5 lg:flex">
        <Logo />
        <div className="flex-1 overflow-y-auto">{nav}</div>
        {footer}
      </aside>

      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-surface/90 px-4 backdrop-blur lg:hidden">
        <Logo />
        <div className="flex items-center gap-1">
          <Link href="/notifications" className="relative flex size-11 items-center justify-center rounded-lg text-muted" aria-label={`Alerts${unread ? `, ${unread} unread` : ""}`}>
            <Bell className="size-5" />
            {unread > 0 && <span className="absolute top-2 right-2 size-2 rounded-full bg-accent" />}
          </Link>
          <button onClick={() => setOpen(true)} className="flex size-11 items-center justify-center rounded-lg text-muted" aria-label="Open menu" aria-expanded={open}>
            <Menu className="size-5" />
          </button>
        </div>
      </header>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 right-0 flex w-72 max-w-[85vw] flex-col gap-6 bg-surface px-3 py-4 shadow-pop">
            <div className="flex items-center justify-between"><Logo /><button onClick={() => setOpen(false)} className="flex size-11 items-center justify-center rounded-lg text-muted" aria-label="Close menu"><X className="size-5" /></button></div>
            <div className="flex-1 overflow-y-auto">{nav}</div>
            {footer}
          </div>
        </div>
      )}

      <main id="main" className="mx-auto w-full max-w-6xl min-w-0 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
    </div>
  );
}
