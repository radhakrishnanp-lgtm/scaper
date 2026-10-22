"use client";

import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover shadow-card",
  secondary: "bg-surface text-text border border-border hover:bg-surface-2 shadow-card",
  ghost: "text-muted hover:text-text hover:bg-surface-2",
  danger: "bg-danger text-white hover:opacity-90 shadow-card",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean; icon?: ReactNode }>(
  function Button({ variant = "primary", size = "md", loading, icon, className, children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors select-none",
          "disabled:opacity-50 disabled:cursor-not-allowed active:translate-y-px",
          size === "sm" ? "h-9 min-w-9 px-3 text-sm" : "h-11 min-w-11 px-4 text-sm",
          variants[variant],
          className,
        )}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...rest}
      >
        {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
        {children}
      </button>
    );
  },
);

const fieldBase = "w-full rounded-lg border border-border bg-surface px-3 text-sm text-text placeholder:text-muted/70 transition-colors hover:border-muted/50 focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input({ className, invalid, ...rest }, ref) {
  return <input ref={ref} className={cn(fieldBase, "h-11", invalid && "border-danger focus:border-danger focus:ring-danger/30", className)} aria-invalid={invalid || undefined} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea({ className, invalid, ...rest }, ref) {
  return <textarea ref={ref} className={cn(fieldBase, "min-h-24 py-2.5 leading-relaxed", invalid && "border-danger", className)} aria-invalid={invalid || undefined} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(function Select({ className, children, invalid, ...rest }, ref) {
  return <select ref={ref} className={cn(fieldBase, "h-11 pr-8", invalid && "border-danger", className)} aria-invalid={invalid || undefined} {...rest}>{children}</select>;
});

/** Label + control + hint + error, wired up for screen readers. */
export function Field({ label, hint, error, children, className }: {
  label: string; hint?: ReactNode; error?: string; className?: string;
  children: (props: { id: string; "aria-describedby"?: string; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children({ id, "aria-describedby": describedBy, invalid: Boolean(error) })}
      {hint && !error && <p id={hintId} className="text-xs text-muted">{hint}</p>}
      {error && <p id={errId} role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  );
}

export function Card({ className, children, as: As = "section" }: { className?: string; children: ReactNode; as?: "section" | "div" | "article" }) {
  return <As className={cn("rounded-[var(--radius-card)] border border-border bg-surface shadow-card", className)}>{children}</As>;
}

export function CardHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
      <div className="min-w-0">
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";
const tones: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted",
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", tones[tone], className)}>{children}</span>;
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="block text-xs text-muted">{description}</span>}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn("relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50", checked ? "bg-accent" : "bg-border")}
      >
        <span className={cn("inline-block size-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-5" : "translate-x-0.5")} />
      </button>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-md", className)} aria-hidden />;
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-5" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">{icon}</div>
      <h3 className="font-semibold">{title}</h3>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorNote({ title = "Something went wrong", message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="m-5 flex flex-wrap items-start justify-between gap-3 rounded-xl border border-danger/30 bg-danger-soft/60 p-4">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-danger">{title}</p>
        <p className="mt-0.5 text-sm break-words">{message}</p>
      </div>
      {onRetry && <Button size="sm" variant="secondary" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; icon?: ReactNode }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-lg border border-border bg-surface-2 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors",
            value === o.value ? "bg-surface text-text shadow-card" : "text-muted hover:text-text",
          )}
        >
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between text-muted">
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
        {icon}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </Card>
  );
}

/* ---------- Additional building blocks ---------- */

export function IconButton({ label, children, className, size = "md", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40",
        size === "sm" ? "size-8" : "size-10",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-surface-2 px-1 font-sans text-[11px] font-medium text-muted", className)}>{children}</kbd>;
}

export function Checkbox({ checked, onChange, label, indeterminate, className, hideLabel, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; indeterminate?: boolean; className?: string; hideLabel?: boolean; disabled?: boolean;
}) {
  return (
    <label className={cn("inline-flex cursor-pointer items-center gap-2 text-sm", disabled && "cursor-not-allowed opacity-50", className)}>
      <input
        type="checkbox"
        className="size-4 cursor-pointer rounded border-border accent-[var(--accent)]"
        checked={checked}
        disabled={disabled}
        ref={(el) => { if (el) el.indeterminate = Boolean(indeterminate) && !checked; }}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={hideLabel ? label : undefined}
      />
      {!hideLabel && <span>{label}</span>}
    </label>
  );
}

export function Progress({ value, max = 100, className, tone = "accent", label }: { value: number | null; max?: number; className?: string; tone?: "accent" | "success" | "danger" | "warning"; label: string }) {
  const pct = value === null ? null : Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  const bar = { accent: "bg-accent", success: "bg-success", danger: "bg-danger", warning: "bg-warning" }[tone];
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-2", className)} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value ?? undefined}>
      {pct === null
        ? <div className={cn("h-full w-1/3 animate-[indeterminate_1.2s_ease-in-out_infinite] rounded-full", bar)} />
        : <div className={cn("h-full rounded-full transition-[width] duration-300", bar)} style={{ width: `${pct}%` }} />}
    </div>
  );
}

/** Tabs with roving focus. `value` is controlled so pages can keep the tab in the URL. */
export function Tabs<T extends string>({ value, onChange, tabs, className, size = "md" }: {
  value: T; onChange: (v: T) => void; tabs: { value: T; label: string; icon?: ReactNode; count?: number | null; hidden?: boolean }[]; className?: string; size?: "sm" | "md";
}) {
  const uid = useId();
  const visible = tabs.filter((t) => !t.hidden);
  const move = (dir: number) => {
    const i = visible.findIndex((t) => t.value === value);
    const next = visible[(i + dir + visible.length) % visible.length]!;
    onChange(next.value);
    requestAnimationFrame(() => document.getElementById(`${uid}-tab-${next.value}`)?.focus());
  };
  return (
    <div role="tablist" className={cn("flex gap-1 overflow-x-auto border-b border-border", className)} onKeyDown={(e) => { if (e.key === "ArrowRight") move(1); if (e.key === "ArrowLeft") move(-1); }}>
      {visible.map((t) => (
        <button
          key={t.value}
          id={`${uid}-tab-${t.value}`}
          role="tab"
          type="button"
          aria-selected={value === t.value}
          tabIndex={value === t.value ? 0 : -1}
          onClick={() => onChange(t.value)}
          className={cn(
            "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 font-medium whitespace-nowrap transition-colors",
            size === "sm" ? "h-9 text-xs" : "h-11 text-sm",
            value === t.value ? "border-accent text-text" : "border-transparent text-muted hover:text-text",
          )}
        >
          {t.icon}
          {t.label}
          {t.count !== undefined && t.count !== null && <span className={cn("rounded-full px-1.5 text-[11px] tabular-nums", value === t.value ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted")}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Free-text chips (tags, keywords). Enter or comma adds; Backspace on empty removes the last. */
export function TagInput({ value, onChange, placeholder = "Add tag", suggestions = [], max = 12, id, label }: {
  value: string[]; onChange: (v: string[]) => void; placeholder?: string; suggestions?: string[]; max?: number; id?: string; label?: string;
}) {
  const listId = useId();
  const add = (raw: string) => {
    const t = raw.trim().replace(/,$/, "").slice(0, 40);
    if (t && !value.includes(t) && value.length < max) onChange([...value, t]);
  };
  return (
    <div className={cn(fieldBase, "flex min-h-11 flex-wrap items-center gap-1.5 py-1.5")}>
      {value.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 rounded-md bg-surface-2 py-0.5 pr-1 pl-2 text-xs font-medium">
          {t}
          <button type="button" aria-label={`Remove ${t}`} className="rounded px-1 text-muted hover:text-danger" onClick={() => onChange(value.filter((x) => x !== t))}>×</button>
        </span>
      ))}
      <input
        id={id}
        aria-label={label ?? placeholder}
        list={suggestions.length ? listId : undefined}
        className="h-7 min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted/70"
        placeholder={value.length >= max ? "" : placeholder}
        onKeyDown={(e) => {
          const el = e.currentTarget;
          if ((e.key === "Enter" || e.key === ",") && el.value.trim()) { e.preventDefault(); add(el.value); el.value = ""; }
          if (e.key === "Backspace" && !el.value && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={(e) => { if (e.currentTarget.value.trim()) { add(e.currentTarget.value); e.currentTarget.value = ""; } }}
      />
      {suggestions.length > 0 && <datalist id={listId}>{suggestions.filter((s) => !value.includes(s)).map((s) => <option key={s} value={s} />)}</datalist>}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = "Search", className, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; autoFocus?: boolean }) {
  return (
    <div className={cn("relative", className)}>
      <svg viewBox="0 0 24 24" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className={cn(fieldBase, "h-10 pl-9")}
      />
    </div>
  );
}

/** A row of toggle chips, e.g. status filters. */
export function FilterChips<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; count?: number }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
            value === o.value ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface text-muted hover:text-text",
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="tabular-nums opacity-80">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function KeyValue({ items, className }: { items: { label: string; value: ReactNode; hidden?: boolean }[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-2 text-sm", className)}>
      {items.filter((i) => !i.hidden).map((i) => (
        <div key={i.label} className="contents">
          <dt className="text-muted">{i.label}</dt>
          <dd className="min-w-0 break-words">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn("rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12px]", className)}>{children}</code>;
}

/** A section inside a form card: title, help text, then fields. */
export function Section({ title, description, children, actions, className }: { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Small "i" note in a tinted box. */
export function Callout({ tone = "neutral", title, children, icon, action }: { tone?: Tone; title?: string; children?: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  const box: Record<Tone, string> = {
    neutral: "border-border bg-surface-2/60",
    accent: "border-accent/30 bg-accent-soft/40",
    success: "border-success/30 bg-success-soft/50",
    warning: "border-warning/30 bg-warning-soft/60",
    danger: "border-danger/30 bg-danger-soft/60",
  };
  return (
    <div className={cn("flex items-start gap-3 rounded-xl border p-3 text-sm", box[tone])}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && "mt-0.5", "text-muted")}>{children}</div>}
      </div>
      {action}
    </div>
  );
}
