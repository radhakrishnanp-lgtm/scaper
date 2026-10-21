"use client";

import { useId, useState } from "react";

type Point = { x: number; y: number };

function scale(points: Point[], w: number, h: number, pad: number) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
  let [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
  if (minY === maxY) { minY -= 1; maxY += 1; }
  const sx = (x: number) => pad + ((x - minX) / (maxX - minX || 1)) * (w - pad * 2);
  const sy = (y: number) => h - pad - ((y - minY) / (maxY - minY)) * (h - pad * 2);
  return { sx, sy, minY, maxY };
}

/** Small inline trend line for tables and cards. */
export function Sparkline({ values, className, label }: { values: number[]; className?: string; label: string }) {
  if (values.length < 2) return <span className="text-xs text-muted">—</span>;
  const pts = values.map((y, x) => ({ x, y }));
  const { sx, sy } = scale(pts, 100, 28, 2);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const down = values[values.length - 1]! < values[0]!;
  return (
    <svg viewBox="0 0 100 28" className={className ?? "h-7 w-24"} role="img" aria-label={label} preserveAspectRatio="none">
      <path d={d} fill="none" stroke={down ? "var(--success)" : "var(--muted)"} strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** Step chart for price history, with hover read-out and keyboard-accessible summary. */
export function PriceChart({ points, format }: { points: { t: string; v: number }[]; format: (v: number) => string }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) {
    return <div className="flex h-56 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted">The chart appears after the second price check.</div>;
  }
  const W = 720;
  const H = 240;
  const P = 28;
  const pts = points.map((p) => ({ x: Date.parse(p.t), y: p.v }));
  const { sx, sy, minY, maxY } = scale(pts, W, H, P);
  let d = `M${sx(pts[0]!.x)},${sy(pts[0]!.y)}`;
  for (let i = 1; i < pts.length; i++) d += ` H${sx(pts[i]!.x)} V${sy(pts[i]!.y)}`;
  const area = `${d} V${H - P} H${sx(pts[0]!.x)} Z`;
  const low = Math.min(...pts.map((p) => p.y));
  const h = hover !== null ? pts[hover]! : null;
  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-56 w-full"
        role="img"
        aria-labelledby={`${id}-cap`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * W;
          let best = 0;
          pts.forEach((p, i) => { if (Math.abs(sx(p.x) - x) < Math.abs(sx(pts[best]!.x) - x)) best = i; });
          setHover(best);
        }}
      >
        <defs>
          <linearGradient id={`${id}-g`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[minY, (minY + maxY) / 2, maxY].map((v) => (
          <g key={v}>
            <line x1={P} x2={W - P} y1={sy(v)} y2={sy(v)} stroke="var(--border)" strokeDasharray="3 4" />
            <text x={W - P} y={sy(v) - 4} textAnchor="end" fontSize="11" fill="var(--muted)">{format(v)}</text>
          </g>
        ))}
        <line x1={P} x2={W - P} y1={sy(low)} y2={sy(low)} stroke="var(--success)" strokeOpacity="0.5" />
        <path d={area} fill={`url(#${id}-g)`} />
        <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinejoin="round" />
        {h && (
          <g>
            <line x1={sx(h.x)} x2={sx(h.x)} y1={P} y2={H - P} stroke="var(--muted)" strokeOpacity="0.4" />
            <circle cx={sx(h.x)} cy={sy(h.y)} r="4.5" fill="var(--surface)" stroke="var(--accent)" strokeWidth="2" />
          </g>
        )}
      </svg>
      <figcaption id={`${id}-cap`} className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-muted">
        <span>{h ? `${new Date(h.x).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}: ${format(h.y)}` : `${points.length} checks. Green line = lowest price seen (${format(low)}).`}</span>
        <span>{new Date(pts[0]!.x).toLocaleDateString("en-IN")} – {new Date(pts[pts.length - 1]!.x).toLocaleDateString("en-IN")}</span>
      </figcaption>
    </figure>
  );
}
