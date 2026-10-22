import "server-only";
import type { FetchMode } from "@/lib/schemas";
import type { Diagnosis } from "@/lib/types";
import type { ValidationReport } from "@/lib/validation";
import type { FetchErrorCode } from "../fetcher/errors";

export type DiagnoseInput = {
  status: "ok" | "partial" | "error" | "blocked" | "cancelled";
  mode: FetchMode;
  extractType: "auto" | "selectors" | "ai";
  rows: number; okPages: number; failedPages: number; fetched: number;
  error: { code: FetchErrorCode | "unknown"; status?: number | null; message: string; url?: string | null } | null;
  hasSteps: boolean;
  aiFallbackPages: number;
  validation?: ValidationReport | null;
  expected?: { low: number; high: number; median: number } | null;
  /** First page as fetched, to recognise login walls and pages that need JavaScript. */
  firstHtml?: string | null;
  firstText?: string | null;
  url?: string | null;
};

const LOGIN = /<input[^>]+type\s*=\s*["']?password|<form[^>]+(login|signin|sign-in|log-in)/i;
const SCRIPT_TAGS = /<script\b/gi;

export const looksLikeLogin = (html: string) => LOGIN.test(html) && /log ?in|sign ?in|password/i.test(html);

/** Little visible text and many scripts: the content is probably rendered in the browser. */
export function needsJavaScript(html: string, text: string) {
  const scripts = html.match(SCRIPT_TAGS)?.length ?? 0;
  return text.replace(/\s+/g, " ").trim().length < 600 && scripts >= 3;
}

const excerptOf = (text?: string | null) => (text ? text.replace(/\s+/g, " ").trim().slice(0, 400) : undefined);

/**
 * Turns what happened in a run into a failure report: where the problem is (the site, your setup, the data,
 * or Scaper itself), what it means in plain words, and the one next step most likely to fix it.
 * Returns null for a healthy run.
 */
export function diagnoseRun(d: DiagnoseInput): Diagnosis | null {
  if (d.status === "cancelled") return null;
  const e = d.error;
  const base = { url: e?.url ?? d.url ?? null, httpStatus: e?.status ?? null, excerpt: excerptOf(d.firstText) };

  if ((d.status === "error" || d.status === "blocked") && e) {
    switch (e.code) {
      case "blocked":
        return { ...base, code: "bot_check", area: "site", severity: "error", title: "The site showed a bot check or asked Scaper to slow down",
          detail: `${e.message} Scaper stops instead of trying to get around it.`, action: { kind: "site", label: "Slow this site down" } };
      case "robots":
        return { ...base, code: "robots", area: "site", severity: "error", title: "robots.txt asks bots not to load this page",
          detail: e.message, action: { kind: "site", label: "Open site settings" } };
      case "paused":
        return { ...base, code: "site_paused", area: "setup", severity: "error", title: "Requests to this site are paused",
          detail: e.message, action: { kind: "site", label: "Resume the site" } };
      case "http": {
        const s = e.status ?? 0;
        if (s === 404 || s === 410) return { ...base, code: "not_found", area: "site", severity: "error", title: `The page no longer exists (HTTP ${s})`,
          detail: "The start URL moved or was removed. Open it in your browser and paste the new address into the task.", action: { kind: "edit", label: "Update the start URL" } };
        if (s === 401 || s === 403) return { ...base, code: "forbidden", area: "site", severity: "error", title: `The site refused access (HTTP ${s})`,
          detail: "The page needs a login, or the site doesn't allow automated visits. If you have an account, add login steps or your session cookie for this site.",
          action: d.mode === "browser" ? { kind: "steps", label: "Add login steps" } : { kind: "site", label: "Add a session cookie" } };
        if (s === 429) return { ...base, code: "rate_limited", area: "site", severity: "error", title: "Too many requests (HTTP 429)",
          detail: "The site asked Scaper to slow down. Give it a longer delay between pages, or run the task less often.", action: { kind: "site", label: "Slow this site down" } };
        if (s >= 500) return { ...base, code: "server_error", area: "site", severity: "error", title: `The site had a server error (HTTP ${s})`,
          detail: "This is usually temporary. The next run will try again.", action: { kind: "retry", label: "Try again now" } };
        return { ...base, code: "http_error", area: "site", severity: "error", title: `The site answered with HTTP ${s}`, detail: e.message, action: { kind: "retry", label: "Try again now" } };
      }
      case "timeout":
        return { ...base, code: "timeout", area: "site", severity: "error", title: "The page took too long to load",
          detail: `${e.message} Slow sites often load fine on the next try. If it keeps happening, raise the page timeout in Settings → Scraping${d.mode === "browser" ? " or switch the task to Fast mode if the data is in the HTML" : ""}.`,
          action: { kind: "retry", label: "Try again now" } };
      case "network":
        return { ...base, code: "unreachable", area: "site", severity: "error", title: "Scaper could not reach the site",
          detail: `${e.message} Check the address and your internet connection.`, action: { kind: "retry", label: "Try again now" } };
      case "private":
        return { ...base, code: "private_address", area: "setup", severity: "error", title: "The address points inside your network",
          detail: e.message, action: { kind: "setup", label: "Open scraping settings" } };
      case "browser":
        return { ...base, code: "browser", area: "scaper", severity: "error", title: "The scraping browser failed",
          detail: `${e.message} Run "npm run setup:browser" once, or use Fast mode.`, action: { kind: "retry", label: "Try again now" } };
      case "step":
        return { ...base, code: "step_failed", area: "setup", severity: "error", title: "A browser step failed",
          detail: `${e.message} The button or field the step uses may have moved.`, action: { kind: "steps", label: "Fix the steps" } };
      case "too_large":
        return { ...base, code: "too_large", area: "site", severity: "error", title: "The page is too large", detail: e.message, action: { kind: "edit", label: "Edit the task" } };
      default:
        return { ...base, code: "error", area: "scaper", severity: "error", title: "The run failed", detail: e.message, action: { kind: "retry", label: "Try again now" } };
    }
  }

  // The pages loaded, but the data is missing or looks wrong.
  if (d.okPages > 0 && d.rows === 0) {
    const html = d.firstHtml ?? "";
    if (html && looksLikeLogin(html)) {
      return { ...base, code: "login_wall", area: "site", severity: "error", title: "Scaper landed on a login page",
        detail: "The page asks for a password, so the data isn't visible. Add login steps (Browser mode) or your session cookie for this site.",
        action: d.mode === "browser" ? { kind: "steps", label: "Add login steps" } : { kind: "site", label: "Add a session cookie" } };
    }
    if (d.mode === "fast" && html && needsJavaScript(html, d.firstText ?? "")) {
      return { ...base, code: "needs_js", area: "setup", severity: "error", title: "The page builds its content with JavaScript",
        detail: "Fast mode reads the HTML as sent, which here has almost no text. Browser mode waits for the page to render.", action: { kind: "browser", label: "Switch to Browser mode" } };
    }
    if (d.extractType === "selectors") {
      return { ...base, code: "selectors_broken", area: "data", severity: "error", title: "The selectors matched nothing",
        detail: "The page loaded, but none of the elements the task looks for are on it. The site most likely changed its layout.", action: { kind: "heal", label: "Fix with AI" } };
    }
    return { ...base, code: "no_rows", area: "data", severity: "error", title: "No items were found on the page",
      detail: d.extractType === "ai" ? "Your model found nothing that matches the instruction. Check the page in your browser, then make the instruction more specific." : "Auto mode found no list or table. Pick the items with the element picker instead.",
      action: d.extractType === "ai" ? { kind: "edit", label: "Edit the instruction" } : { kind: "picker", label: "Open the picker" } };
  }

  const v = d.validation;
  if (v && v.status === "fail") {
    const failing = v.results.filter((r) => r.status === "fail");
    return { ...base, code: "validation_failed", area: "data", severity: "error", title: `The data failed ${failing.length} check${failing.length === 1 ? "" : "s"}`,
      detail: failing.slice(0, 3).map((r) => `${r.label}: ${r.detail}`).join(" · "),
      action: d.extractType === "selectors" && failing.some((r) => r.check === "not_empty" || r.check === "row_count") ? { kind: "heal", label: "Fix with AI" } : { kind: "quality", label: "Review the checks" } };
  }
  if (d.expected && d.rows < d.expected.low && (d.status === "ok" || d.status === "partial")) {
    return { ...base, code: "fewer_rows", area: "data", severity: "warning", title: `Fewer rows than usual: ${d.rows.toLocaleString("en-IN")}`,
      detail: `Recent runs had about ${d.expected.median.toLocaleString("en-IN")} rows (usual range ${d.expected.low.toLocaleString("en-IN")}–${d.expected.high.toLocaleString("en-IN")}). Part of the page may have changed.`,
      action: d.extractType === "selectors" ? { kind: "heal", label: "Fix with AI" } : { kind: "edit", label: "Edit the task" } };
  }
  if (d.aiFallbackPages > 0) {
    return { ...base, code: "ai_fallback", area: "data", severity: "warning", title: `The selectors stopped matching on ${d.aiFallbackPages} page${d.aiFallbackPages === 1 ? "" : "s"}`,
      detail: "Your AI read those pages instead, so you still got data, but each run now costs AI tokens. Updating the selectors makes it free and faster again.",
      action: { kind: "heal", label: "Fix with AI" } };
  }
  if (d.status === "partial" && e) {
    return { ...base, code: "some_pages_failed", area: "site", severity: "warning", title: `${d.failedPages} of ${d.fetched} pages failed`,
      detail: `The first error: ${e.message}`, action: { kind: "retry", label: "Run again" } };
  }
  if (v && v.status === "warn") {
    const warns = v.results.filter((r) => r.status === "warn");
    return { ...base, code: "validation_warn", area: "data", severity: "warning", title: `${warns.length} data check${warns.length === 1 ? "" : "s"} need a look`,
      detail: warns.slice(0, 3).map((r) => `${r.label}: ${r.detail}`).join(" · "), action: { kind: "quality", label: "Review the checks" } };
  }
  return null;
}

/** Usual row count from recent good runs: median ± 3 × MAD (at least ±25% of the median). Needs 5 runs. */
export function expectedRange(counts: number[]): { low: number; high: number; median: number } | null {
  if (counts.length < 5) return null;
  const sorted = [...counts].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const dev = counts.map((c) => Math.abs(c - median)).sort((a, b) => a - b);
  const mad = dev[Math.floor(dev.length / 2)]!;
  const spread = Math.max(3 * 1.4826 * mad, median * 0.25, 1);
  return { low: Math.max(0, Math.floor(median - spread)), high: Math.ceil(median + spread), median };
}
