/** Line and word diffs for the change viewer. Runs in the browser on two snapshots' text. */

export type LineOp = { op: "+" | "-" | " "; text: string; a: number | null; b: number | null };
export type Seg = { text: string; changed: boolean };

const MAX_LCS = 2500;

function lcsOps<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): ("=" | "-" | "+")[] {
  const n = a.length;
  const m = b.length;
  const table = new Uint16Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] = eq(a[i]!, b[j]!) ? table[at(i + 1, j + 1)]! + 1 : Math.max(table[at(i + 1, j)]!, table[at(i, j + 1)]!);
    }
  }
  const out: ("=" | "-" | "+")[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && eq(a[i]!, b[j]!)) { out.push("="); i++; j++; }
    else if (i < n && (j >= m || table[at(i + 1, j)]! >= table[at(i, j + 1)]!)) { out.push("-"); i++; }
    else { out.push("+"); j++; }
  }
  return out;
}

/** Every line of both texts, marked kept, removed or added, with line numbers on each side. */
export function lineDiff(before: string, after: string): LineOp[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);
  const out: LineOp[] = [];
  for (let k = 0; k < start; k++) out.push({ op: " ", text: a[k]!, a: k + 1, b: k + 1 });
  let ia = start;
  let ib = start;
  if (midA.length > MAX_LCS || midB.length > MAX_LCS) {
    // Too big for an exact diff: show everything removed, then everything added.
    const inB = new Set(midB);
    const inA = new Set(midA);
    for (const t of midA) { out.push(inB.has(t) ? { op: " ", text: t, a: ++ia, b: null } : { op: "-", text: t, a: ++ia, b: null }); }
    for (const t of midB) { if (!inA.has(t)) out.push({ op: "+", text: t, a: null, b: ++ib }); else ++ib; }
  } else {
    for (const op of lcsOps(midA, midB, (x, y) => x === y)) {
      if (op === "=") out.push({ op: " ", text: a[ia]!, a: ++ia, b: ++ib });
      else if (op === "-") out.push({ op: "-", text: a[ia]!, a: ++ia, b: null });
      else out.push({ op: "+", text: b[ib]!, a: null, b: ++ib });
    }
  }
  for (let k = endA + 1; k < a.length; k++) out.push({ op: " ", text: a[k]!, a: ++ia, b: ++ib });
  return out;
}

const tokens = (s: string) => s.match(/\s+|\w+|[^\s\w]/g) ?? [];

/** Which words changed between an old and a new version of one line. */
export function wordDiff(before: string, after: string): { before: Seg[]; after: Seg[] } {
  const a = tokens(before);
  const b = tokens(after);
  if (a.length > 400 || b.length > 400) return { before: [{ text: before, changed: true }], after: [{ text: after, changed: true }] };
  const ops = lcsOps(a, b, (x, y) => x === y);
  const left: Seg[] = [];
  const right: Seg[] = [];
  const push = (arr: Seg[], text: string, changed: boolean) => {
    const last = arr[arr.length - 1];
    if (last && last.changed === changed) last.text += text; else arr.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === "=") { push(left, a[i++]!, false); push(right, b[j++]!, false); }
    else if (op === "-") push(left, a[i++]!, true);
    else push(right, b[j++]!, true);
  }
  return { before: left, after: right };
}

export type Row = { kind: "line"; op: LineOp; words?: Seg[] } | { kind: "gap"; count: number; from: number };

/** Unified rows; unchanged runs longer than 2×context collapse into a gap (unless expanded). */
export function unifiedRows(ops: LineOp[], context: number | null, expanded: Set<number> = new Set()): Row[] {
  const words = pairWords(ops);
  const rows: Row[] = [];
  if (context === null) return ops.map((op, i) => ({ kind: "line", op, words: words.get(i) }));
  const keep = ops.map((o) => o.op !== " ");
  const near = ops.map((_, i) => {
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) if (keep[k]) return true;
    return false;
  });
  let i = 0;
  while (i < ops.length) {
    if (near[i]) { rows.push({ kind: "line", op: ops[i]!, words: words.get(i) }); i++; continue; }
    const from = i;
    while (i < ops.length && !near[i]) i++;
    // A one-line gap is not worth a "show more" row.
    if (expanded.has(from) || i - from <= 1) for (let k = from; k < i; k++) rows.push({ kind: "line", op: ops[k]!, words: words.get(k) });
    else rows.push({ kind: "gap", count: i - from, from });
  }
  return rows;
}

/** Pairs each run of removed lines with the following run of added lines, for word-level highlights. */
function pairWords(ops: LineOp[]): Map<number, Seg[]> {
  const out = new Map<number, Seg[]>();
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.op !== "-") { i++; continue; }
    const dels: number[] = [];
    while (i < ops.length && ops[i]!.op === "-") dels.push(i++);
    const adds: number[] = [];
    while (i < ops.length && ops[i]!.op === "+") adds.push(i++);
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const w = wordDiff(ops[dels[k]!]!.text, ops[adds[k]!]!.text);
      // Only worth highlighting words when most of the line stayed the same.
      const same = w.after.filter((s) => !s.changed).reduce((n, s) => n + s.text.length, 0);
      if (same / Math.max(1, ops[adds[k]!]!.text.length) >= 0.3) { out.set(dels[k]!, w.before); out.set(adds[k]!, w.after); }
    }
  }
  return out;
}

export type SplitRow = { kind: "pair"; left: LineOp | null; right: LineOp | null; leftWords?: Seg[]; rightWords?: Seg[] } | { kind: "gap"; count: number; from: number };

/** Side-by-side rows: removed lines on the left facing the lines that replaced them on the right. */
export function splitRows(ops: LineOp[], context: number | null, expanded: Set<number> = new Set()): SplitRow[] {
  const unified = unifiedRows(ops, context, expanded);
  const out: SplitRow[] = [];
  let i = 0;
  while (i < unified.length) {
    const r = unified[i]!;
    if (r.kind === "gap") { out.push(r); i++; continue; }
    if (r.op.op === " ") { out.push({ kind: "pair", left: r.op, right: r.op }); i++; continue; }
    const dels: Extract<Row, { kind: "line" }>[] = [];
    while (i < unified.length && unified[i]!.kind === "line" && (unified[i] as Extract<Row, { kind: "line" }>).op.op === "-") dels.push(unified[i++] as Extract<Row, { kind: "line" }>);
    const adds: Extract<Row, { kind: "line" }>[] = [];
    while (i < unified.length && unified[i]!.kind === "line" && (unified[i] as Extract<Row, { kind: "line" }>).op.op === "+") adds.push(unified[i++] as Extract<Row, { kind: "line" }>);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      out.push({ kind: "pair", left: dels[k]?.op ?? null, right: adds[k]?.op ?? null, leftWords: dels[k]?.words, rightWords: adds[k]?.words });
    }
  }
  return out;
}
