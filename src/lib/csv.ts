import type { Cell } from "./types";

/** RFC 4180 CSV. Cells starting with = + - @ are prefixed with ' so spreadsheets don't run them as formulas. */
export function toCsv(columns: string[], rows: Record<string, Cell>[]): string {
  const esc = (v: Cell) => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => esc(c)).join(","), ...rows.map((r) => columns.map((c) => esc(r[c] ?? null)).join(","))].join("\r\n");
}

/** RFC 4180 parser (quotes, escaped quotes, CRLF). Returns rows of cells. */
export function parseCsv(text: string, maxRows = 100_000): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      if (rows.length >= maxRows) return rows;
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

/** CSV with a header row → objects keyed by header. */
export function csvRecords(text: string, maxRows = 10_000): Record<string, string>[] {
  const [head, ...rest] = parseCsv(text, maxRows + 1);
  if (!head) return [];
  const keys = head.map((h) => h.trim());
  return rest.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

/** Replaces {{name}} with values (URL-encoded when `encode` is set). Unknown names are left as they are. */
export function fillTemplate(template: string, vars: Record<string, string>, encode = false) {
  return template.replace(/\{\{\s*([\w\- ]+?)\s*\}\}/g, (m, k: string) => (k in vars ? (encode ? encodeURIComponent(vars[k]!) : vars[k]!) : m));
}
