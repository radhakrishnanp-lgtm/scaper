"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { lineDiff, splitRows, unifiedRows, type LineOp, type Seg } from "@/lib/diff";
import { Segmented, Switch } from "./ui";

type Mode = "unified" | "split";

function Words({ segs, tone }: { segs: Seg[]; tone: "add" | "del" }) {
  return <>{segs.map((s, i) => s.changed ? <mark key={i} className={cn("rounded-sm text-inherit", tone === "add" ? "diff-add" : "diff-del")}>{s.text}</mark> : <span key={i}>{s.text}</span>)}</>;
}

const rowTone = (op: LineOp["op"]) => (op === "+" ? "bg-success-soft/50" : op === "-" ? "bg-danger-soft/50" : "");

/** Before/after text with line and word highlights, unified or side by side, unchanged runs folded. */
export function DiffViewer({ before, after, beforeLabel = "Before", afterLabel = "After" }: { before: string; after: string; beforeLabel?: string; afterLabel?: string }) {
  const [mode, setMode] = useState<Mode>("unified");
  const [onlyChanges, setOnlyChanges] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const ops = useMemo(() => lineDiff(before, after), [before, after]);
  const added = ops.filter((o) => o.op === "+").length;
  const removed = ops.filter((o) => o.op === "-").length;
  const context = onlyChanges ? 3 : null;
  const expand = (from: number) => setExpanded((s) => new Set(s).add(from));
  const gap = (count: number, from: number, cols: number) => (
    <tr key={`gap-${from}`}>
      <td colSpan={cols} className="bg-surface-2/50 px-3 py-1 text-center">
        <button type="button" onClick={() => expand(from)} className="text-xs text-accent hover:underline">Show {count} unchanged line{count === 1 ? "" : "s"}</button>
      </td>
    </tr>
  );
  const num = "w-10 shrink-0 select-none px-2 text-right align-top text-muted tabular-nums";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-sm">
          <span className="font-medium text-success">+{added}</span>
          <span className="font-medium text-danger">−{removed}</span>
          <span className="text-muted">lines</span>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Switch label="Only changes" checked={onlyChanges} onChange={(v) => { setOnlyChanges(v); setExpanded(new Set()); }} />
          <Segmented label="Diff layout" value={mode} onChange={setMode} options={[{ value: "unified", label: "Inline" }, { value: "split", label: "Side by side" }]} />
        </div>
      </div>
      {added === 0 && removed === 0 ? <p className="rounded-lg bg-surface-2 p-4 text-sm text-muted">The two versions are identical.</p> : (
        <div className="scroll-thin max-h-[65vh] overflow-auto rounded-xl border border-border font-mono text-xs leading-relaxed">
          {mode === "unified" ? (
            <table className="w-full border-collapse">
              <tbody>
                {unifiedRows(ops, context, expanded).map((r, i) => r.kind === "gap" ? gap(r.count, r.from, 4) : (
                  <tr key={i} className={rowTone(r.op.op)}>
                    <td className={num}>{r.op.a ?? ""}</td>
                    <td className={num}>{r.op.b ?? ""}</td>
                    <td className={cn("w-5 select-none text-center align-top", r.op.op === "+" ? "text-success" : r.op.op === "-" ? "text-danger" : "text-muted")}>{r.op.op === " " ? "" : r.op.op === "-" ? "−" : "+"}</td>
                    <td className="pr-3 break-all whitespace-pre-wrap">{r.words ? <Words segs={r.words} tone={r.op.op === "+" ? "add" : "del"} /> : r.op.text || " "}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="w-full table-fixed border-collapse">
              <thead className="sticky top-0 bg-surface-2 font-sans text-xs text-muted">
                <tr><th className="w-10" /><th className="px-2 py-1.5 text-left font-medium">{beforeLabel}</th><th className="w-10 border-l border-border" /><th className="px-2 py-1.5 text-left font-medium">{afterLabel}</th></tr>
              </thead>
              <tbody>
                {splitRows(ops, context, expanded).map((r, i) => r.kind === "gap" ? gap(r.count, r.from, 4) : (
                  <tr key={i}>
                    <td className={cn(num, r.left?.op === "-" && "bg-danger-soft/50")}>{r.left?.a ?? ""}</td>
                    <td className={cn("pr-2 align-top break-all whitespace-pre-wrap", r.left?.op === "-" && "bg-danger-soft/50", !r.left && "bg-surface-2/40")}>{r.left ? (r.leftWords ? <Words segs={r.leftWords} tone="del" /> : r.left.text || " ") : ""}</td>
                    <td className={cn(num, "border-l border-border", r.right?.op === "+" && "bg-success-soft/50")}>{r.right?.b ?? ""}</td>
                    <td className={cn("pr-2 align-top break-all whitespace-pre-wrap", r.right?.op === "+" && "bg-success-soft/50", !r.right && "bg-surface-2/40")}>{r.right ? (r.rightWords ? <Words segs={r.rightWords} tone="add" /> : r.right.text || " ") : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
