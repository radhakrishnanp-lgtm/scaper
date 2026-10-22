"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

/** Closes on outside click and Escape; returns focus to the trigger. */
function useDismiss(open: boolean, close: () => void, root: React.RefObject<HTMLElement | null>, trigger: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); trigger.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, close, root, trigger]);
}

export type MenuItem =
  | { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  | { label: string; icon?: ReactNode; href: string; download?: boolean; external?: boolean; hint?: string }
  | { separator: true }
  | { heading: string };

/** Dropdown menu with arrow-key navigation. */
export function Menu({ trigger, items, align = "end", label, className }: {
  trigger: (props: { onClick: () => void; "aria-expanded": boolean; "aria-haspopup": "menu"; "aria-controls": string; ref: React.Ref<HTMLButtonElement> }) => ReactNode;
  items: MenuItem[]; align?: "start" | "end"; label: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), root, btn);
  useEffect(() => {
    if (open) requestAnimationFrame(() => list.current?.querySelector<HTMLElement>("[role=menuitem]:not([aria-disabled=true])")?.focus());
  }, [open]);
  const focusMove = (dir: number) => {
    const els = [...(list.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([aria-disabled=true])") ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    els[(i + dir + els.length) % els.length]?.focus();
  };
  const itemClass = (danger?: boolean) => cn(
    "flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none focus:bg-surface-2 hover:bg-surface-2",
    danger ? "text-danger" : "text-text",
  );
  return (
    <div ref={root} className={cn("relative inline-block", className)}>
      {trigger({ onClick: () => setOpen((o) => !o), "aria-expanded": open, "aria-haspopup": "menu", "aria-controls": id, ref: btn })}
      {open && (
        <div
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); focusMove(1); }
            if (e.key === "ArrowUp") { e.preventDefault(); focusMove(-1); }
            if (e.key === "Tab") setOpen(false);
          }}
          className={cn("pop-in absolute z-40 mt-1.5 min-w-52 rounded-xl border border-border bg-surface p-1 shadow-pop", align === "end" ? "right-0" : "left-0")}
        >
          {items.map((it, i) => {
            if ("separator" in it) return <div key={i} role="separator" className="my-1 h-px bg-border" />;
            if ("heading" in it) return <div key={i} className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">{it.heading}</div>;
            const body = <>{it.icon && <span className="text-muted [&>svg]:size-4">{it.icon}</span>}<span className="flex-1">{it.label}</span>{it.hint && <span className="text-xs text-muted">{it.hint}</span>}</>;
            if ("href" in it) {
              if (it.download || it.external) {
                return <a key={i} role="menuitem" tabIndex={-1} href={it.href} download={it.download || undefined} target={it.external ? "_blank" : undefined} rel={it.external ? "noreferrer noopener" : undefined} className={itemClass()} onClick={() => setOpen(false)}>{body}</a>;
              }
              return <Link key={i} role="menuitem" tabIndex={-1} href={it.href} className={itemClass()} onClick={() => setOpen(false)}>{body}</Link>;
            }
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={it.disabled || undefined}
                disabled={it.disabled}
                className={cn(itemClass(it.danger), it.disabled && "opacity-40")}
                onClick={() => { setOpen(false); it.onSelect(); }}
              >
                {body}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A panel anchored to a trigger (alerts list, running jobs). */
export function Popover({ trigger, children, align = "end", label, panelClassName }: {
  trigger: (props: { onClick: () => void; "aria-expanded": boolean; ref: React.Ref<HTMLButtonElement> }) => ReactNode;
  children: (close: () => void) => ReactNode; align?: "start" | "end"; label: string; panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useDismiss(open, () => setOpen(false), root, btn);
  return (
    <div ref={root} className="relative">
      {trigger({ onClick: () => setOpen((o) => !o), "aria-expanded": open, ref: btn })}
      {open && (
        <div role="dialog" aria-label={label} className={cn("pop-in absolute z-40 mt-2 w-[min(92vw,380px)] rounded-xl border border-border bg-surface shadow-pop", align === "end" ? "right-0" : "left-0", panelClassName)}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
