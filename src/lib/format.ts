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
