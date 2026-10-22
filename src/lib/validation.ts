/**
 * Data validation for scraped rows: column profiles, expectations ("rules") checked on every run, and
 * rule suggestions from a good run. Pure functions, so the editor can preview results in the browser.
 */
import type { Cell, Dataset } from "./types";
import type { ValidationRule } from "./schemas";

export type RuleStatus = "pass" | "warn" | "fail";
export type RuleResult = {
  ruleId: string; label: string; column: string; check: ValidationRule["check"]; severity: ValidationRule["severity"];
  status: RuleStatus; passed: number; total: number; percent: number; detail: string;
  examples: { row: number; value: Cell }[];
};
export type ValidationReport = {
  score: number | null; status: RuleStatus | "none"; results: RuleResult[];
  counts: Record<RuleStatus, number>;
};

export type ColumnType = "number" | "url" | "image" | "date" | "boolean" | "email" | "text" | "list" | "json" | "empty";
export type ColumnProfile = {
  column: string; type: ColumnType; filled: number; fill: number; distinct: number; unique: boolean;
  min: number | null; max: number | null; mean: number | null; median: number | null;
  minLength: number | null; maxLength: number | null; top: { value: string; count: number }[];
};

export const isEmpty = (v: Cell | undefined) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/** Numbers as scraped: 1,299.00 · ₹ 2,499 · 12.5% → plain numbers. */
export function toNumber(v: Cell | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[\s,₹$€£¥%]|rs\.?|inr/gi, "");
  if (!/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const URL_RE = /^https?:\/\/[^\s]+$/i;
const IMAGE_RE = /\.(png|jpe?g|webp|gif|avif|svg)(\?|#|$)|\/images?\/|image|img|photo|media/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$|^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$|^[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4}$|^\d{1,2} [A-Z][a-z]{2,8}\.? \d{4}$/;

export function matchesType(v: Cell, type: string): boolean {
  if (isEmpty(v)) return false;
  const s = String(v).trim();
  switch (type) {
    case "number": return toNumber(v) !== null;
    case "integer": { const n = toNumber(v); return n !== null && Number.isInteger(n); }
    case "url": return URL_RE.test(s);
    case "image": return URL_RE.test(s) && IMAGE_RE.test(s);
    case "date": return DATE_RE.test(s) || (/\d{4}/.test(s) && !Number.isNaN(Date.parse(s)));
    case "email": return EMAIL_RE.test(s);
    case "boolean": return typeof v === "boolean" || /^(true|false|yes|no)$/i.test(s);
    default: return true;
  }
}

/** The kind of values a column holds, from a sample: decides cell rendering, filters and suggested rules. */
export function inferType(values: Cell[]): ColumnType {
  const vals = values.filter((v) => !isEmpty(v)).slice(0, 200);
  if (!vals.length) return "empty";
  const share = (fn: (v: Cell) => boolean) => vals.filter(fn).length / vals.length;
  if (share((v) => typeof v === "boolean") > 0.9) return "boolean";
  if (share((v) => typeof v === "number" || toNumber(v) !== null) > 0.9) return "number";
  if (share((v) => matchesType(v, "image")) > 0.8 && share((v) => /\.(png|jpe?g|webp|gif|avif|svg)(\?|$)/i.test(String(v))) > 0.5) return "image";
  if (share((v) => matchesType(v, "url")) > 0.9) return "url";
  if (share((v) => matchesType(v, "email")) > 0.9) return "email";
  if (share((v) => typeof v === "string" && DATE_RE.test(v.trim())) > 0.9) return "date";
  if (share((v) => typeof v === "string" && /^[[{]/.test(v.trim())) > 0.9) return "json";
  if (share((v) => typeof v === "string" && v.includes(" | ")) > 0.6) return "list";
  return "text";
}

export function profileColumn(ds: Dataset, column: string): ColumnProfile {
  const values = ds.rows.map((r) => r[column] ?? null);
  const present = values.filter((v) => !isEmpty(v));
  const type = inferType(values);
  const nums = present.map(toNumber).filter((n): n is number => n !== null).sort((a, b) => a - b);
  const lengths = present.map((v) => String(v).length);
  const counts = new Map<string, number>();
  for (const v of present) { const k = String(v); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const useNums = type === "number" && nums.length > 0;
  return {
    column, type, filled: present.length,
    fill: ds.rows.length ? Math.round((present.length / ds.rows.length) * 1000) / 10 : 0,
    distinct: counts.size, unique: present.length > 1 && counts.size === present.length,
    min: useNums ? nums[0]! : null, max: useNums ? nums[nums.length - 1]! : null,
    mean: useNums ? Math.round((nums.reduce((s, n) => s + n, 0) / nums.length) * 100) / 100 : null,
    median: useNums ? nums[Math.floor(nums.length / 2)]! : null,
    minLength: lengths.length ? Math.min(...lengths) : null, maxLength: lengths.length ? Math.max(...lengths) : null,
    top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([value, count]) => ({ value, count })),
  };
}

export const profileDataset = (ds: Dataset) => ds.columns.map((c) => profileColumn(ds, c));

const fmt = (n: number | null) => (n === null ? "" : n.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const between = (min: number | null, max: number | null, unit = "") =>
  min !== null && max !== null ? `between ${fmt(min)} and ${fmt(max)}${unit}` : min !== null ? `at least ${fmt(min)}${unit}` : `at most ${fmt(max)}${unit}`;

/** A rule in plain words, for lists, alerts and issues. */
export function describeRule(r: ValidationRule): string {
  const mostly = r.mostly < 100 ? ` in ${r.mostly}% of rows` : "";
  switch (r.check) {
    case "not_empty": return `${r.column} is filled in${mostly}`;
    case "unique": return `${r.column} has no duplicates${mostly}`;
    case "pattern": return `${r.column} matches /${r.arg}/${mostly}`;
    case "range": return `${r.column} is ${between(r.min, r.max)}${mostly}`;
    case "one_of": return `${r.column} is one of ${r.arg.split("|").map((s) => s.trim()).filter(Boolean).slice(0, 6).join(", ")}${mostly}`;
    case "type": return `${r.column} is ${r.arg === "integer" ? "a whole number" : r.arg === "image" ? "an image link" : r.arg === "url" ? "a link" : r.arg === "email" ? "an email address" : `a ${r.arg}`}${mostly}`;
    case "length": return `${r.column} is ${between(r.min, r.max, " characters long")}${mostly}`;
    case "row_count": return `The run has ${between(r.min, r.max, " rows")}`;
    case "duplicates": return `At most ${fmt(r.max ?? 0)}% of rows are exact duplicates`;
  }
}

function checkValue(r: ValidationRule, v: Cell, re: RegExp | null, allowed: Set<string> | null): boolean {
  switch (r.check) {
    case "pattern": return re!.test(String(v));
    case "range": { const n = toNumber(v); return n !== null && (r.min === null || n >= r.min) && (r.max === null || n <= r.max); }
    case "one_of": return allowed!.has(String(v).trim().toLowerCase());
    case "type": return matchesType(v, r.arg);
    case "length": { const l = String(v).length; return (r.min === null || l >= r.min) && (r.max === null || l <= r.max); }
    default: return true;
  }
}

export function runRule(ds: Dataset, r: ValidationRule): RuleResult {
  const base = { ruleId: r.id, label: describeRule(r), column: r.column, check: r.check, severity: r.severity };
  const finish = (passed: number, total: number, detail: string, examples: RuleResult["examples"] = []): RuleResult => {
    const percent = total ? Math.round((passed / total) * 1000) / 10 : 100;
    const status: RuleStatus = percent >= r.mostly ? "pass" : r.severity;
    return { ...base, status, passed, total, percent, detail, examples: examples.slice(0, 5) };
  };
  if (r.check === "row_count") {
    const n = ds.rows.length;
    const ok = (r.min === null || n >= r.min) && (r.max === null || n <= r.max);
    return { ...finish(ok ? 1 : 0, 1, `${n.toLocaleString("en-IN")} rows`), percent: ok ? 100 : 0, status: ok ? "pass" : r.severity };
  }
  if (r.check === "duplicates") {
    const seen = new Set<string>();
    let dup = 0;
    for (const row of ds.rows) { const k = JSON.stringify(ds.columns.map((c) => row[c] ?? null)); if (seen.has(k)) dup++; else seen.add(k); }
    const pct = ds.rows.length ? Math.round((dup / ds.rows.length) * 1000) / 10 : 0;
    const ok = pct <= (r.max ?? 0);
    return { ...finish(ds.rows.length - dup, ds.rows.length, `${dup} duplicate row(s), ${pct}%`), percent: ok ? 100 : Math.round((100 - pct) * 10) / 10, status: ok ? "pass" : r.severity };
  }
  if (!ds.columns.includes(r.column)) return { ...finish(0, Math.max(1, ds.rows.length), `The column "${r.column}" is missing from this run.`), percent: 0, status: r.severity };
  if (r.check === "not_empty") {
    const bad = ds.rows.map((row, i) => ({ row: i, value: row[r.column] ?? null })).filter((x) => isEmpty(x.value));
    return finish(ds.rows.length - bad.length, ds.rows.length, bad.length ? `${bad.length} empty value(s)` : "Every row has a value", bad);
  }
  if (r.check === "unique") {
    const first = new Map<string, number>();
    const bad: RuleResult["examples"] = [];
    let total = 0;
    ds.rows.forEach((row, i) => {
      const v = row[r.column];
      if (isEmpty(v)) return;
      total++;
      const k = String(v);
      if (first.has(k)) bad.push({ row: i, value: v ?? null }); else first.set(k, i);
    });
    return finish(total - bad.length, total, bad.length ? `${bad.length} repeated value(s)` : "All values are different", bad);
  }
  let re: RegExp | null = null;
  try { re = r.check === "pattern" ? new RegExp(r.arg, "i") : null; } catch { return { ...finish(0, 1, "The pattern is not a valid regular expression."), percent: 0, status: r.severity }; }
  const allowed = r.check === "one_of" ? new Set(r.arg.split("|").map((s) => s.trim().toLowerCase()).filter(Boolean)) : null;
  const bad: RuleResult["examples"] = [];
  let total = 0;
  ds.rows.forEach((row, i) => {
    const v = row[r.column];
    if (isEmpty(v)) return; // Empty values are the "not empty" rule's job.
    total++;
    if (!checkValue(r, v ?? null, re, allowed)) bad.push({ row: i, value: v ?? null });
  });
  return finish(total - bad.length, total, bad.length ? `${bad.length} of ${total} value(s) don't match` : total ? "All values match" : "No values to check", bad);
}

export function runValidation(ds: Dataset, rules: ValidationRule[]): ValidationReport {
  const active = rules.filter((r) => r.enabled);
  const results = active.map((r) => runRule(ds, r));
  const counts = { pass: 0, warn: 0, fail: 0 } as Record<RuleStatus, number>;
  for (const r of results) counts[r.status]++;
  const score = results.length ? Math.round((results.reduce((s, r) => s + Math.min(100, r.percent), 0) / results.length) * 10) / 10 : null;
  const status = !results.length ? "none" : counts.fail ? "fail" : counts.warn ? "warn" : "pass";
  return { score, status, results, counts };
}

const ruleId = () => Math.random().toString(36).slice(2, 10);
const IGNORED = (c: string) => c.endsWith("_value") || c === "source_url" || c.startsWith("input_");

/**
 * Rules that describe a good run, so the next broken run stands out: columns that are always filled stay filled,
 * links stay links, numbers stay numbers in a plausible range, keys stay unique, and the row count stays near today's.
 */
export function suggestRules(ds: Dataset, opts: { keyFields?: string[] } = {}): ValidationRule[] {
  const rules: ValidationRule[] = [];
  const base = { arg: "", min: null, max: null, mostly: 100, severity: "fail" as const, enabled: true, note: "" };
  if (ds.rows.length) {
    rules.push({ ...base, id: ruleId(), column: "*", check: "row_count", min: Math.max(1, Math.floor(ds.rows.length * 0.5)), note: "Half of the rows in the run these rules came from" });
  }
  for (const p of profileDataset(ds)) {
    if (IGNORED(p.column) || p.type === "empty") continue;
    if (p.fill >= 99) rules.push({ ...base, id: ruleId(), column: p.column, check: "not_empty", mostly: 95 });
    else if (p.fill >= 60) rules.push({ ...base, id: ruleId(), column: p.column, check: "not_empty", mostly: Math.max(50, Math.floor(p.fill - 15)), severity: "warn" });
    if (p.type === "number") {
      rules.push({ ...base, id: ruleId(), column: p.column, check: "type", arg: "number", mostly: 95 });
      if (p.min !== null && p.max !== null && p.min >= 0) {
        rules.push({ ...base, id: ruleId(), column: p.column, check: "range", min: 0, max: Math.ceil(p.max * 5), mostly: 98, severity: "warn", note: "Up to five times today's highest value" });
      }
    } else if (p.type === "url" || p.type === "image") {
      rules.push({ ...base, id: ruleId(), column: p.column, check: "type", arg: "url", mostly: 98 });
    } else if (p.type === "date" || p.type === "email") {
      rules.push({ ...base, id: ruleId(), column: p.column, check: "type", arg: p.type, mostly: 95, severity: "warn" });
    } else if (p.type === "text" && p.distinct > 0 && p.distinct <= 6 && p.filled >= 20) {
      rules.push({ ...base, id: ruleId(), column: p.column, check: "one_of", arg: p.top.map((t) => t.value).join(" | "), mostly: 95, severity: "warn", note: "The values seen today" });
    }
  }
  const keys = opts.keyFields?.length ? opts.keyFields : profileDataset(ds).filter((p) => p.unique && (p.type === "url" || /id|sku|asin|link|url/i.test(p.column))).slice(0, 1).map((p) => p.column);
  for (const k of keys) if (ds.columns.includes(k)) rules.push({ ...base, id: ruleId(), column: k, check: "unique", mostly: 99 });
  if (ds.rows.length > 5) rules.push({ ...base, id: ruleId(), column: "*", check: "duplicates", max: 5, severity: "warn" });
  return rules;
}
