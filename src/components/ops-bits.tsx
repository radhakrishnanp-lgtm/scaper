"use client";

import { useCallback, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertOctagon, AlertTriangle, Bot, CheckCircle2, Globe, ImageIcon, Server, Settings2, Sparkles, Wrench, XCircle } from "lucide-react";
import type { RuleResult } from "@/lib/validation";
import type { Diagnosis, DiagnosisAction } from "@/lib/types";
import { cn } from "@/lib/cn";
import { dateTime } from "@/lib/format";
import { Dialog } from "./dialog";
import { Badge, Button } from "./ui";

export type RunPoint = { id?: string; at: string; status: string; rows: number; ms: number; score?: number | null; version?: number | null };

const STATUS_FILL: Record<string, string> = { ok: "var(--success)", partial: "var(--warning)", error: "var(--danger)", blocked: "var(--danger)", cancelled: "var(--border)" };
export const statusLabel = (s: string) => ({ ok: "Succeeded", partial: "Partly failed", error: "Failed", blocked: "Blocked", cancelled: "Cancelled" }[s] ?? s);

function useWidth(fallback: number) {
  const [width, setWidth] = useState(fallback);
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => { const w = Math.round(e!.contentRect.width); if (w > 0) setWidth(w); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * One cell per run (or per day): green worked, amber partly, red failed, grey nothing ran.
 * Like an uptime bar: the shape of the last weeks at a glance, with a read-out on hover.
 */
export function StatusStrip({ cells, label, className, height = 28 }: {
  cells: { key: string; status: "ok" | "partial" | "failed" | "none" | string; title: string }[]; label: string; className?: string; height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const color = (s: string) => (s === "ok" ? "var(--success)" : s === "partial" ? "var(--warning)" : s === "failed" || s === "error" || s === "blocked" ? "var(--danger)" : "var(--surface-2)");
  return (
    <div className={cn("relative", className)} onMouseLeave={() => setHover(null)}>
      <div role="img" aria-label={label} className="flex gap-[2px]" style={{ height }}>
        {cells.map((c, i) => (
          <span
            key={c.key}
            onMouseEnter={() => setHover(i)}
            className={cn("min-w-[3px] flex-1 rounded-[3px] transition-opacity", hover !== null && hover !== i && "opacity-60", c.status === "none" && "border border-border")}
            style={{ background: color(c.status) }}
          />
        ))}
      </div>
      {hover !== null && cells[hover] && (
        <div className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-pop"
          style={{ left: `${Math.min(88, Math.max(12, ((hover + 0.5) / cells.length) * 100))}%` }}>
          {cells[hover]!.title}
        </div>
      )}
    </div>
  );
}

/** Daily cells from {day, ok, failed, other}: red if anything failed, amber if mixed, green if all worked. */
export function dailyCells(daily: { day: string; ok: number; failed: number; other: number }[]) {
  return daily.map((d) => {
    const total = d.ok + d.failed + d.other;
    const status = !total ? "none" : d.failed && !d.ok ? "failed" : d.failed ? "partial" : "ok";
    const when = new Date(`${d.day}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    return { key: d.day, status, title: total ? `${when}: ${d.ok} worked${d.failed ? `, ${d.failed} failed` : ""}${d.other ? `, ${d.other} other` : ""}` : `${when}: no runs` };
  });
}

/**
 * Rows (or duration) per run as a line with status-coloured dots, and the usual range shaded behind it,
 * so a run that falls out of the band stands out. Hover a run for its details; click to open it.
 */
export function RunChart({ runs, metric, band, height = 200, onOpen, label }: {
  runs: RunPoint[]; metric: "rows" | "ms" | "score"; band?: { low: number; high: number; median: number } | null; height?: number;
  onOpen?: (r: RunPoint) => void; label: string;
}) {
  const [box, W] = useWidth(640);
  const [hover, setHover] = useState<number | null>(null);
  const pts = runs.filter((r) => metric !== "score" || r.score !== null && r.score !== undefined);
  if (pts.length < 2) return <div className="flex items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted" style={{ height }}>The chart appears after the second run.</div>;
  const val = (r: RunPoint) => (metric === "rows" ? r.rows : metric === "ms" ? r.ms / 1000 : r.score ?? 0);
  const fmt = (v: number) => (metric === "ms" ? `${v < 10 ? v.toFixed(1) : Math.round(v)} s` : metric === "score" ? `${Math.round(v)}` : Math.round(v).toLocaleString("en-IN"));
  const H = height;
  const P = { l: 44, r: 12, t: 12, b: 24 };
  const values = pts.map(val);
  let max = Math.max(...values, band && metric === "rows" ? band.high : 0, metric === "score" ? 100 : 0);
  let min = metric === "score" ? Math.min(0, ...values) : 0;
  if (max === min) { max += 1; min = Math.max(0, min - 1); }
  const x = (i: number) => P.l + (i / (pts.length - 1)) * (W - P.l - P.r);
  const y = (v: number) => H - P.b - ((v - min) / (max - min)) * (H - P.t - P.b);
  const line = pts.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(val(r)).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${y(min)} L${x(0).toFixed(1)},${y(min)} Z`;
  const ticks = [min, (min + max) / 2, max];
  const h = hover !== null ? pts[hover] : null;
  const showBand = metric === "rows" && band;
  return (
    <figure ref={box} className="relative select-none">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H, cursor: onOpen ? "pointer" : undefined }} role="img" aria-label={label}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          setHover(Math.max(0, Math.min(pts.length - 1, Math.round(((px - P.l) / (W - P.l - P.r)) * (pts.length - 1)))));
        }}
        onMouseLeave={() => setHover(null)}
        onClick={() => { if (hover !== null && onOpen) onOpen(pts[hover]!); }}
      >
        {showBand && (
          <g>
            <rect x={P.l} width={W - P.l - P.r} y={y(band.high)} height={Math.max(1, y(band.low) - y(band.high))} fill="var(--accent)" opacity="0.08" />
            <line x1={P.l} x2={W - P.r} y1={y(band.median)} y2={y(band.median)} stroke="var(--accent)" strokeOpacity="0.35" strokeDasharray="4 4" />
          </g>
        )}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray={i ? "3 4" : undefined} />
            <text x={P.l - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="var(--muted)">{fmt(t)}</text>
          </g>
        ))}
        <path d={area} fill="var(--accent)" opacity="0.06" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {pts.map((r, i) => {
          const out = showBand && (val(r) < band.low || val(r) > band.high);
          return <circle key={r.id ?? i} cx={x(i)} cy={y(val(r))} r={hover === i ? 5.5 : out || r.status !== "ok" ? 4.5 : 3}
            fill={STATUS_FILL[r.status] ?? "var(--accent)"} stroke="var(--surface)" strokeWidth="2" />;
        })}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={P.t} y2={H - P.b} stroke="var(--muted)" strokeOpacity="0.4" />}
        {[0, pts.length - 1].map((i) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor={i ? "end" : "start"} fontSize="10" fill="var(--muted)">
            {new Date(pts[i]!.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
          </text>
        ))}
      </svg>
      {showBand && <figcaption className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm bg-accent/15" />Usual range {band.low.toLocaleString("en-IN")}–{band.high.toLocaleString("en-IN")}</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-success" />worked</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-warning" />partly failed</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-danger" />failed</span>
      </figcaption>}
      {h && hover !== null && (
        <div className="pointer-events-none absolute top-0 z-10 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-pop"
          style={{ left: `${Math.min(82, Math.max(8, (x(hover) / W) * 100))}%`, transform: "translateX(-50%)" }}>
          <p className="font-medium">{dateTime(h.at)}</p>
          <p className="text-muted">{statusLabel(h.status)} · <span className="text-text tabular-nums">{h.rows.toLocaleString("en-IN")}</span> rows · {(h.ms / 1000).toFixed(1)} s</p>
          {(h.score !== null && h.score !== undefined) && <p className="text-muted">Data score <span className="text-text tabular-nums">{h.score}</span></p>}
          {h.version ? <p className="text-muted">Setup v{h.version}</p> : null}
        </div>
      )}
    </figure>
  );
}

/** Validation score with its meaning in words, never colour alone. */
export function ScoreBadge({ score, status }: { score: number | null | undefined; status?: string | null }) {
  if (score === null || score === undefined) return <span className="text-xs text-muted">—</span>;
  const tone = status === "fail" ? "danger" : status === "warn" ? "warning" : score >= 95 ? "success" : score >= 80 ? "warning" : "danger";
  return <Badge tone={tone}>{Math.round(score)}{status === "fail" ? " · failed" : status === "warn" ? " · warnings" : ""}</Badge>;
}

const AREA: Record<Diagnosis["area"], { label: string; icon: ReactNode; hint: string }> = {
  site: { label: "The website", icon: <Globe className="size-3.5" />, hint: "Something on the site's side: it refused, failed or changed." },
  setup: { label: "Your setup", icon: <Settings2 className="size-3.5" />, hint: "A setting of this task or site needs a change." },
  data: { label: "The data", icon: <AlertTriangle className="size-3.5" />, hint: "The pages loaded, but the data is missing or looks wrong." },
  scaper: { label: "Scaper", icon: <Server className="size-3.5" />, hint: "Something on this computer: the browser, a timeout, a crash." },
};

const ACTION_ICON: Partial<Record<DiagnosisAction, ReactNode>> = { heal: <Sparkles className="size-4" />, steps: <Wrench className="size-4" />, site: <Globe className="size-4" />, browser: <Bot className="size-4" /> };

/**
 * The failure report: where the problem is, what it means, what the page looked like, and one button
 * for the next step most likely to fix it.
 */
export function DiagnosisCard({ d, onAction, actionHref, busy, compact }: {
  d: Diagnosis; onAction?: (kind: DiagnosisAction) => void; actionHref?: (kind: DiagnosisAction) => string | undefined; busy?: boolean; compact?: boolean;
}) {
  const [shot, setShot] = useState(false);
  const area = AREA[d.area];
  const href = d.action ? actionHref?.(d.action.kind) : undefined;
  const error = d.severity === "error";
  const btn = d.action && (
    <Button size="sm" variant={error ? "primary" : "secondary"} icon={ACTION_ICON[d.action.kind]} loading={busy} onClick={href ? undefined : () => onAction?.(d.action!.kind)}>
      {d.action.label}
    </Button>
  );
  return (
    <section className={cn("overflow-hidden rounded-[var(--radius-card)] border", error ? "border-danger/40 bg-danger-soft/25" : "border-warning/40 bg-warning-soft/25")} aria-label="What went wrong">
      <div className="flex flex-col gap-4 p-4 sm:flex-row">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {error ? <AlertOctagon className="size-4 text-danger" aria-hidden /> : <AlertTriangle className="size-4 text-warning" aria-hidden />}
            <span className="font-semibold uppercase tracking-wide text-muted">{error ? "What went wrong" : "Needs a look"}</span>
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-muted" title={area.hint}>{area.icon}{area.label}</span>
            {d.httpStatus ? <Badge>HTTP {d.httpStatus}</Badge> : null}
          </div>
          <h3 className="text-base font-semibold leading-snug">{d.title}</h3>
          <p className="text-sm text-muted">{d.detail}</p>
          {!compact && d.excerpt && (
            <details className="text-sm">
              <summary className="cursor-pointer text-xs font-medium text-muted hover:text-text">What the page said</summary>
              <p className="mt-1.5 rounded-lg bg-surface/80 p-2.5 font-mono text-xs leading-relaxed text-muted">{d.excerpt}</p>
            </details>
          )}
          {d.action && <div className="pt-1">{href ? <Link prefetch={false} href={href}>{btn}</Link> : btn}</div>}
        </div>
        {d.screenshot && !compact && (
          <button type="button" onClick={() => setShot(true)} className="group relative shrink-0 self-start overflow-hidden rounded-lg border border-border bg-surface sm:w-56" aria-label="Open the screenshot of the page">
            {/* eslint-disable-next-line @next/next/no-img-element -- local media route */}
            <img src={`/api/media/${d.screenshot}`} alt="The page when it failed" className="aspect-[4/3] w-full object-cover object-top transition-transform group-hover:scale-[1.02]" />
            <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] text-white"><ImageIcon className="size-3" />Screenshot</span>
          </button>
        )}
      </div>
      {shot && d.screenshot && (
        <Dialog open onClose={() => setShot(false)} xl title="The page when it failed" description={d.url ?? undefined} footer={<Button variant="secondary" onClick={() => setShot(false)}>Close</Button>}>
          {/* eslint-disable-next-line @next/next/no-img-element -- local media route */}
          <img src={`/api/media/${d.screenshot}`} alt="The page when it failed" className="w-full rounded-lg border border-border" />
        </Dialog>
      )}
    </section>
  );
}

/** Where each failure-report action leads, for pages outside the task itself. */
export function diagnosisHref(taskId: string | null | undefined, host: string | null | undefined) {
  return (kind: DiagnosisAction): string | undefined => {
    switch (kind) {
      case "heal": return taskId ? `/tasks/${taskId}?view=health&fix=1` : undefined;
      case "picker": case "edit": return taskId ? `/tasks/${taskId}/edit?tab=extract` : "/scrape";
      case "steps": return taskId ? `/tasks/${taskId}/edit?tab=steps` : undefined;
      case "browser": return taskId ? `/tasks/${taskId}/edit?tab=start` : undefined;
      case "quality": return taskId ? `/tasks/${taskId}?view=checks` : undefined;
      case "limits": return taskId ? `/tasks/${taskId}/edit?tab=pages` : undefined;
      case "site": return host ? `/sites?host=${encodeURIComponent(host)}` : "/sites";
      case "setup": return "/settings?tab=scraping";
      default: return undefined;
    }
  };
}

/** The result of each data check on one run: pass/warn/fail with an icon and word, share of rows that passed, and examples. */
export function CheckResults({ results, empty }: { results: RuleResult[]; empty?: ReactNode }) {
  if (!results.length) return <>{empty ?? <p className="text-sm text-muted">No data checks yet.</p>}</>;
  const order = { fail: 0, warn: 1, pass: 2 } as const;
  return (
    <ul className="divide-y divide-border rounded-xl border border-border">
      {[...results].sort((a, b) => order[a.status] - order[b.status]).map((r) => (
        <li key={r.ruleId} className="flex gap-3 px-4 py-3">
          {r.status === "pass" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="Passed" />
            : r.status === "warn" ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Warning" />
            : <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Failed" />}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <p className="text-sm font-medium">{r.label}</p>
              <span className="text-xs tabular-nums text-muted">{r.check === "row_count" || r.check === "duplicates" ? r.detail : `${r.percent}% of ${r.total.toLocaleString("en-IN")}`}</span>
            </div>
            {r.status !== "pass" && r.check !== "row_count" && r.check !== "duplicates" && <p className="text-xs text-muted">{r.detail}</p>}
            {r.status !== "pass" && r.examples.length > 0 && (
              <p className="mt-1 flex flex-wrap gap-1.5 text-xs">
                {r.examples.slice(0, 4).map((e, i) => <code key={i} className="max-w-[16rem] truncate rounded bg-surface-2 px-1.5 py-0.5">row {e.row + 1}: {e.value === null || e.value === "" ? "(empty)" : String(e.value).slice(0, 60)}</code>)}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
