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
