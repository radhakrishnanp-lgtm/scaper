"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Job } from "@/server/repo/jobs";
import { api } from "@/lib/api-client";
import { useToast } from "./toast";

export type LiveEvent =
  | { type: "hello" }
  | { type: "notification"; id: string; title: string; body: string; url: string | null; desktop: boolean }
  | { type: "watcher"; id: string; status: string }
  | { type: "product"; id: string }
  | { type: "agent"; id: string; status: string }
  | { type: "job"; id: string; status: string; kind: string; title: string; progress?: Record<string, unknown> }
  | { type: "deal_search"; id: string }
  | { type: "task_run"; id: string; recipeId: string; status: string }
  | { type: "bot"; id: string; status: string }
  | { type: "download"; id: string; status: string; bytes: number; total: number | null; name: string };

type Counts = { queued: number; running: number; paused: number; succeeded: number; failed: number; cancelled: number };
type LiveState = {
  connected: boolean;
  unread: number;
  setUnread: (n: number) => void;
  counts: Counts | null;
  /** Changes in the inbox not reviewed yet (last 90 days). */
  inbox: number;
  setInbox: (n: number) => void;
  active: Job[];
  refreshJobs: () => void;
  subscribe: (fn: (e: LiveEvent) => void) => () => void;
};

const LiveContext = createContext<LiveState>({
  connected: false, unread: 0, setUnread: () => undefined, counts: null, inbox: 0, setInbox: () => undefined, active: [], refreshJobs: () => undefined, subscribe: () => () => undefined,
});

export const useLive = () => useContext(LiveContext);

/** Calls `fn` for every live event (job progress, new alerts ...) while the component is mounted. */
export function useLiveEvents(fn: (e: LiveEvent) => void) {
  const { subscribe } = useLive();
  const ref = useRef(fn);
  useEffect(() => { ref.current = fn; });
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}

/**
 * One Server-Sent Events connection for the whole app. New alerts become toasts and
 * (when allowed) desktop notifications; job changes keep the running-jobs indicator
 * current; every event nudges open pages to refresh their data quietly.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; });
  const [connected, setConnected] = useState(false);
  const [unread, setUnread] = useState(0);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [inbox, setInbox] = useState(0);
  const [active, setActive] = useState<Job[]>([]);
  const listeners = useRef(new Set<(e: LiveEvent) => void>());

  const refreshJobs = useCallback(() => {
    api<{ items: Job[]; counts: Counts }>("/api/jobs?status=active&limit=12").then((d) => { setActive(d.items); setCounts(d.counts); }).catch(() => undefined);
  }, []);
  const refreshUnread = useCallback(() => {
    api<{ unread: number }>("/api/notifications?limit=1").then((d) => setUnread(d.unread)).catch(() => undefined);
    api<{ counts: { unreviewed: number } }>("/api/changes?limit=1").then((d) => setInbox(d.counts.unreviewed)).catch(() => undefined);
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    let jobsTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      es = new EventSource("/api/notifications/stream");
      es.onopen = () => setConnected(true);
      es.onmessage = (msg) => {
        let e: LiveEvent;
        try { e = JSON.parse(msg.data) as LiveEvent; } catch { return; }
        if (e.type === "hello") return;
        listeners.current.forEach((fn) => fn(e));
        if (e.type === "notification") {
          refreshUnread();
          toastRef.current.info(e.title, e.body?.split("\n")[0], { label: "Open alerts", onClick: () => window.dispatchEvent(new CustomEvent("scaper:navigate", { detail: "/notifications" })) });
          if (e.desktop && "Notification" in window && Notification.permission === "granted") {
            const n = new Notification(e.title || "Scaper", { body: e.body?.slice(0, 200), tag: e.id });
            n.onclick = () => { window.focus(); window.dispatchEvent(new CustomEvent("scaper:navigate", { detail: "/notifications" })); };
          }
        }
        if (e.type === "job") {
          clearTimeout(jobsTimer);
          jobsTimer = setTimeout(refreshJobs, 250);
          // Progress ticks are frequent; only finished jobs need pages to reload.
          if (e.status === "running" && e.progress && Object.keys(e.progress).length) return;
        }
        clearTimeout(refresh);
        refresh = setTimeout(() => window.dispatchEvent(new Event("scaper:live")), 400);
      };
      es.onerror = () => { setConnected(false); es?.close(); retry = setTimeout(connect, 5000); };
    };
    connect();
    refreshUnread();
    refreshJobs();
    return () => { es?.close(); clearTimeout(retry); clearTimeout(refresh); clearTimeout(jobsTimer); };
  }, [refreshJobs, refreshUnread]);

  const subscribe = useCallback((fn: (e: LiveEvent) => void) => {
    listeners.current.add(fn);
    return () => { listeners.current.delete(fn); };
  }, []);

  return (
    <LiveContext.Provider value={{ connected, unread, setUnread, counts, inbox, setInbox, active, refreshJobs, subscribe }}>
      {children}
    </LiveContext.Provider>
  );
}
