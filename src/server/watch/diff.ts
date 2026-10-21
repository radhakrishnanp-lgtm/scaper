import type { DiffSummary } from "../repo/watchers";

const MAX_LCS_LINES = 1500;
const MAX_PATCH = 300;

/**
 * Line diff: trims the shared start and end, then runs an LCS on what is left
 * (bounded, so a huge page can't stall the server). Returns counts plus a short patch with one line of context.
 */
export function diffLines(before: string, after: string): DiffSummary {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);

  let ops: { op: "+" | "-" | " "; text: string }[];
  if (midA.length > MAX_LCS_LINES || midB.length > MAX_LCS_LINES) {
    const setA = new Set(midA);
    const setB = new Set(midB);
    ops = [...midA.filter((l) => !setB.has(l)).map((text) => ({ op: "-" as const, text })),
      ...midB.filter((l) => !setA.has(l)).map((text) => ({ op: "+" as const, text }))];
  } else {
    const n = midA.length;
    const m = midB.length;
    const table = new Uint16Array((n + 1) * (m + 1));
    const at = (i: number, j: number) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[at(i, j)] = midA[i] === midB[j] ? table[at(i + 1, j + 1)]! + 1 : Math.max(table[at(i + 1, j)]!, table[at(i, j + 1)]!);
      }
    }
    ops = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) { ops.push({ op: " ", text: midA[i]! }); i++; j++; }
      // Removals first, so a replaced line reads "- old" then "+ new".
      else if (i < n && (j >= m || table[at(i + 1, j)]! >= table[at(i, j + 1)]!)) { ops.push({ op: "-", text: midA[i]! }); i++; }
      else { ops.push({ op: "+", text: midB[j]! }); j++; }
    }
  }

  const added = ops.filter((o) => o.op === "+").length;
  const removed = ops.filter((o) => o.op === "-").length;
  const before1 = start > 0 ? [{ op: " " as const, text: a[start - 1]! }] : [];
  const after1 = endA + 1 < a.length ? [{ op: " " as const, text: a[endA + 1]! }] : [];
  // Keep only changed lines and their immediate neighbours.
  const compact = ops.filter((o, idx) => o.op !== " " || ops[idx - 1]?.op !== " " || ops[idx + 1]?.op !== " ");
  const patch = [...before1, ...compact, ...after1].slice(0, MAX_PATCH).map((o) => ({ ...o, text: o.text.slice(0, 500) }));
  return { added, removed, patch };
}

export function summarizeDiff(d: DiffSummary, max = 3): string {
  const lines = d.patch.filter((p) => p.op === "+").slice(0, max).map((p) => `+ ${p.text.slice(0, 140)}`);
  const removed = d.patch.filter((p) => p.op === "-").slice(0, lines.length ? 1 : max).map((p) => `- ${p.text.slice(0, 140)}`);
  const head = `${d.added} line${d.added === 1 ? "" : "s"} added, ${d.removed} removed.`;
  return [head, ...lines, ...removed].join("\n");
}
