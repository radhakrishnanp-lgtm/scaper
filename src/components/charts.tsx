"use client";

import { useCallback, useId, useMemo, useState } from "react";
import { cn } from "@/lib/cn";

type Point = { x: number; y: number };

function scale(points: Point[], w: number, h: number, pad: { l: number; r: number; t: number; b: number }, yDomain?: [number, number]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
  let [minY, maxY] = yDomain ?? [Math.min(...ys), Math.max(...ys)];
  if (minY === maxY) { minY -= Math.abs(minY) * 0.05 || 1; maxY += Math.abs(maxY) * 0.05 || 1; }
  const span = maxY - minY;
  minY -= span * 0.06;
  maxY += span * 0.06;
  const sx = (x: number) => pad.l + ((x - minX) / (maxX - minX || 1)) * (w - pad.l - pad.r);
  const sy = (y: number) => h - pad.b - ((Math.min(Math.max(y, minY), maxY) - minY) / (maxY - minY)) * (h - pad.t - pad.b);
  return { sx, sy, minY, maxY };
}

/** Small inline trend line for tables and cards. */
export function Sparkline({ values, className, label }: { values: number[]; className?: string; label: string }) {
  if (values.length < 2) return <span className="text-xs text-muted">—</span>;
  const pts = values.map((y, x) => ({ x, y }));
  const { sx, sy } = scale(pts, 100, 28, { l: 2, r: 2, t: 2, b: 2 });
  const d = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const down = values[values.length - 1]! < values[0]!;
  return (
    <svg viewBox="0 0 100 28" className={className ?? "h-7 w-24"} role="img" aria-label={label} preserveAspectRatio="none">
      <path d={d} fill="none" stroke={down ? "var(--success)" : "var(--muted)"} strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export type BarSeries = { key: string; label: string; color: string };

/**
 * Stacked daily bars (jobs per day, alerts per day). Rounded tops, a 2px surface gap
 * between segments, a legend when there is more than one series, and a hover read-out.
 */
/** The chart box's real width, so SVG text and bars keep their size instead of being scaled to fit. */
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

export function BarChart({ data, series, height = 160, format = (v) => v.toLocaleString("en-IN"), label, emptyText = "No data yet." }: {
  data: { label: string; values: Record<string, number> }[]; series: BarSeries[]; height?: number; format?: (v: number) => string; label: string; emptyText?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [box, W] = useWidth(600);
  const totals = data.map((d) => series.reduce((a, s) => a + (d.values[s.key] ?? 0), 0));
  const max = Math.max(1, ...totals);
  if (!data.length || totals.every((t) => t === 0)) {
    return <div className="flex items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted" style={{ height }}>{emptyText}</div>;
  }
  const H = height;
  const P = { l: 34, r: 8, t: 10, b: 22 };
  const slot = (W - P.l - P.r) / data.length;
  const bw = Math.max(3, Math.min(28, slot * 0.62));
  const y = (v: number) => H - P.b - (v / max) * (H - P.t - P.b);
  const ticks = [0, max / 2, max].map((v) => Math.round(v));
  const h = hover !== null ? data[hover] : null;
  return (
    <figure ref={box} className="relative">
      {series.length > 1 && (
        <figcaption className="mb-2 flex flex-wrap gap-3 text-xs text-muted">
          {series.map((s) => <span key={s.key} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: s.color }} />{s.label}</span>)}
        </figcaption>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray={i ? "3 4" : undefined} />
            <text x={P.l - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="var(--muted)">{format(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = P.l + slot * i + slot / 2;
          let acc = 0;
          const segs = series.map((s) => {
            const v = d.values[s.key] ?? 0;
            const top = y(acc + v);
            const bottom = y(acc);
            acc += v;
            return { s, v, top, bottom };
          }).filter((x) => x.v > 0);
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={cx - slot / 2} y={P.t} width={slot} height={H - P.t - P.b} fill="transparent" />
              {segs.map(({ s, top, bottom }, k) => {
                const last = k === segs.length - 1;
                const hgt = Math.max(0, bottom - top - (k > 0 ? 2 : 0));
                const r = last ? Math.min(4, bw / 2, hgt) : 0;
                const x0 = cx - bw / 2;
                const yb = bottom - (k > 0 ? 2 : 0);
                const path = `M${x0},${yb} V${yb - hgt + r} Q${x0},${yb - hgt} ${x0 + r},${yb - hgt} H${x0 + bw - r} Q${x0 + bw},${yb - hgt} ${x0 + bw},${yb - hgt + r} V${yb} Z`;
                return <path key={s.key} d={path} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.55} />;
              })}
              {(i === 0 || i === data.length - 1 || i === Math.floor(data.length / 2)) && (
                <text x={cx} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--muted)">{d.label}</text>
              )}
            </g>
          );
        })}
      </svg>
      {h && hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-pop"
          style={{ left: `${Math.min(80, Math.max(5, ((P.l + slot * hover + slot / 2) / W) * 100))}%`, transform: "translateX(-50%)" }}
        >
          <p className="font-medium">{h.label}</p>
          {series.map((s) => (
            <p key={s.key} className="flex items-center gap-1.5 text-muted"><span className="size-2 rounded-sm" style={{ background: s.color }} />{s.label}: <span className="text-text tabular-nums">{format(h.values[s.key] ?? 0)}</span></p>
          ))}
        </div>
      )}
    </figure>
  );
}

const RANGES = [
  { key: "7d", label: "1W", days: 7 }, { key: "30d", label: "1M", days: 30 }, { key: "90d", label: "3M", days: 90 },
  { key: "180d", label: "6M", days: 180 }, { key: "365d", label: "1Y", days: 365 }, { key: "all", label: "All", days: Infinity },
] as const;

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  return sorted[lo]! + (sorted[Math.min(sorted.length - 1, lo + 1)]! - sorted[lo]!) * (i - lo);
}

/**
 * Price (or any value) over time, Keepa-style: step line, range buttons, a "close-up" that
 * ignores extreme spikes, and reference lines for the lowest price, the average and your target.
 */
export function PriceChart({ points, format, step = true, target, label = "Price history", emptyText = "The chart appears after the second check.", height = 240 }: {
  points: { t: string; v: number }[]; format: (v: number) => string; step?: boolean; target?: number | null; label?: string; emptyText?: string; height?: number;
}) {
  const id = useId();
  const [box, W] = useWidth(760);
  const [hover, setHover] = useState<number | null>(null);
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("all");
  const [closeUp, setCloseUp] = useState(false);
  const all = useMemo(() => points.map((p) => ({ x: Date.parse(p.t), y: p.v })).sort((a, b) => a.x - b.x), [points]);
  const span = all.length > 1 ? (all[all.length - 1]!.x - all[0]!.x) / 86400_000 : 0;
  const days = RANGES.find((r) => r.key === range)!.days;
  const pts = useMemo(() => {
    if (!Number.isFinite(days) || !all.length) return all;
    const cut = all[all.length - 1]!.x - days * 86400_000;
    const inside = all.filter((p) => p.x >= cut);
    // Carry the last price before the window in, so the line starts at the window's left edge.
    const before = [...all].reverse().find((p) => p.x < cut);
    return before ? [{ x: cut, y: before.y }, ...inside] : inside;
  }, [all, days]);

  if (all.length < 2) {
    return <div className="flex items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted" style={{ height }}>{emptyText}</div>;
  }
  const H = height;
  const P = { l: 8, r: 64, t: 12, b: 24 };
  const ys = pts.map((p) => p.y);
  const sorted = [...ys].sort((a, b) => a - b);
  const domain: [number, number] | undefined = closeUp && sorted.length > 4 ? [percentile(sorted, 0.05), percentile(sorted, 0.95)] : undefined;
  const view = pts.length >= 2 ? pts : all;
  const { sx, sy, minY, maxY } = scale(view, W, H, P, domain);
  let d = `M${sx(view[0]!.x)},${sy(view[0]!.y)}`;
  for (let i = 1; i < view.length; i++) d += step ? ` H${sx(view[i]!.x)} V${sy(view[i]!.y)}` : ` L${sx(view[i]!.x)},${sy(view[i]!.y)}`;
  if (step) d += ` H${W - P.r}`;
  const area = `${d} V${H - P.b} H${sx(view[0]!.x)} Z`;
  const low = Math.min(...ys);
  const avg = ys.reduce((a, b) => a + b, 0) / ys.length;
  const h = hover !== null ? view[hover] : null;
  const refs = [
    { v: low, color: "var(--success)", label: `Low ${format(low)}`, dash: undefined },
    { v: avg, color: "var(--muted)", label: `Avg ${format(avg)}`, dash: "4 4" },
    ...(target ? [{ v: target, color: "var(--warning)", label: `Target ${format(target)}`, dash: "2 3" }] : []),
  ].filter((r) => r.v >= minY && r.v <= maxY);

  return (
    <figure ref={box}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Time range" className="inline-flex rounded-lg border border-border bg-surface-2 p-0.5">
          {RANGES.filter((r) => r.key === "all" || r.days < span * 1.5 || r.days <= 7).map((r) => (
            <button key={r.key} role="radio" aria-checked={range === r.key} onClick={() => { setRange(r.key); setHover(null); }}
              className={cn("h-7 rounded-md px-2.5 text-xs font-medium", range === r.key ? "bg-surface text-text shadow-card" : "text-muted hover:text-text")}>
              {r.label}
            </button>
          ))}
        </div>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={closeUp} onChange={(e) => setCloseUp(e.target.checked)} className="accent-[var(--accent)]" />
          Close-up (ignore spikes)
        </label>
        <span className="ml-auto flex flex-wrap gap-3 text-xs text-muted">
          {refs.map((r) => <span key={r.label} className="inline-flex items-center gap-1"><span className="h-0.5 w-3" style={{ background: r.color }} />{r.label}</span>)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height }}
        role="img"
        aria-labelledby={`${id}-cap`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * W;
          let best = 0;
          view.forEach((p, i) => { if (Math.abs(sx(p.x) - x) < Math.abs(sx(view[best]!.x) - x)) best = i; });
          setHover(best);
        }}
      >
        <defs>
          <linearGradient id={`${id}-g`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[minY, (minY + maxY) / 2, maxY].map((v, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={sy(v)} y2={sy(v)} stroke="var(--border)" strokeDasharray="3 4" />
            <text x={W - P.r + 6} y={sy(v) + 4} fontSize="11" fill="var(--muted)">{format(v)}</text>
          </g>
        ))}
        {refs.map((r) => <line key={r.label} x1={P.l} x2={W - P.r} y1={sy(r.v)} y2={sy(r.v)} stroke={r.color} strokeOpacity="0.7" strokeDasharray={r.dash} />)}
        <path d={area} fill={`url(#${id}-g)`} />
        <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
        <text x={P.l} y={H - 6} fontSize="11" fill="var(--muted)">{new Date(view[0]!.x).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" })}</text>
        <text x={W - P.r} y={H - 6} textAnchor="end" fontSize="11" fill="var(--muted)">{new Date(view[view.length - 1]!.x).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" })}</text>
        {h && (
          <g>
            <line x1={sx(h.x)} x2={sx(h.x)} y1={P.t} y2={H - P.b} stroke="var(--muted)" strokeOpacity="0.4" />
            <circle cx={sx(h.x)} cy={sy(h.y)} r="5" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />
          </g>
        )}
      </svg>
      <figcaption id={`${id}-cap`} className="mt-1 text-xs text-muted">
        {h ? <span><span className="font-medium text-text">{format(h.y)}</span> on {new Date(h.x).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span> : `${label}: ${view.length} points. Hover for details.`}
      </figcaption>
    </figure>
  );
}
