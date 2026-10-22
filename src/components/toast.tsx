"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import { cn } from "@/lib/cn";

type Toast = { id: number; tone: "success" | "error" | "info"; title: string; body?: string; action?: { label: string; onClick: () => void } };
type Ctx = { push: (t: Omit<Toast, "id">) => void };

const ToastContext = createContext<Ctx>({ push: () => undefined });

export function useToast() {
  const { push } = useContext(ToastContext);
  return {
    success: (title: string, body?: string, action?: Toast["action"]) => push({ tone: "success", title, body, action }),
    error: (title: string, body?: string) => push({ tone: "error", title, body }),
    info: (title: string, body?: string, action?: Toast["action"]) => push({ tone: "info", title, body, action }),
  };
}

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = ++seq;
    setToasts((all) => [...all.slice(-3), { ...t, id }]);
    setTimeout(() => dismiss(id), t.tone === "error" ? 8000 : 5000);
  }, [dismiss]);
  const Icon = { success: CheckCircle2, error: AlertTriangle, info: Info };
  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      {/* Bottom centre, where forms rarely put buttons; the toast body lets clicks through so it never blocks a Save button. */}
      <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4">
        {toasts.map((t) => {
          const I = Icon[t.tone];
          return (
            <div key={t.id} role={t.tone === "error" ? "alert" : "status"} className="toast-in flex w-full max-w-sm items-start gap-3 rounded-xl border border-border bg-surface p-3.5 shadow-pop">
              <I className={cn("mt-0.5 size-5 shrink-0", t.tone === "success" && "text-success", t.tone === "error" && "text-danger", t.tone === "info" && "text-accent")} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{t.title}</p>
                {t.body && <p className="mt-0.5 text-sm break-words text-muted">{t.body}</p>}
                {t.action && <button className="pointer-events-auto mt-1.5 text-sm font-medium text-accent hover:underline" onClick={() => { t.action!.onClick(); dismiss(t.id); }}>{t.action.label}</button>}
              </div>
              <button onClick={() => dismiss(t.id)} className="pointer-events-auto rounded p-1 text-muted hover:text-text" aria-label="Dismiss"><X className="size-4" /></button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
