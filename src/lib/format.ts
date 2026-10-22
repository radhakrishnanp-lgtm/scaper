export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = Date.now() - Date.parse(iso);
  const abs = Math.abs(diff);
  const future = diff < 0;
  const units: [number, string][] = [[86400_000, "d"], [3600_000, "h"], [60_000, "m"], [1000, "s"]];
  for (const [ms, label] of units) {
    if (abs >= ms) {
      const n = Math.floor(abs / ms);
      return future ? `in ${n}${label}` : `${n}${label} ago`;
    }
  }
  return future ? "in a moment" : "just now";
}

export function money(v: number | null | undefined, currency?: string | null) {
  if (v === null || v === undefined) return "—";
  try {
    return currency
      ? new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: v % 1 ? 2 : 0 }).format(v)
      : v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  } catch {
    return v.toLocaleString("en-IN");
  }
}

export function interval(minutes: number) {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} min`;
}

export function hostOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

export function dateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

export function duration(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function bytes(n: number | null | undefined) {
  if (n === null || n === undefined) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${units[i]}`;
}

/** "every 6 hours", "0 9 * * 1-5 (cron)" or "manual". */
export function scheduleText(minutes: number | null | undefined, cron?: string | null) {
  if (cron) return `cron ${cron}`;
  if (minutes) return `every ${interval(minutes)}`;
  return "manual";
}

export function shortDay(iso: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** The last N days as YYYY-MM-DD, oldest first, for charts that need a bar per day even when it is zero. */
export function lastDays(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.now() - (n - 1 - i) * 86400_000);
    return d.toISOString().slice(0, 10);
  });
}

/** "1 row", "2 rows", "1,204 rows". */
export function plural(n: number, word: string, many = `${word}s`) {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? word : many}`;
}
