import "server-only";

/** Recently rendered pages, so the selector lab can test selectors without loading the site again. */
type Entry = { html: string; url: string; at: number };
const g = globalThis as unknown as { __scaperPageCache?: Map<string, Entry> };
const cache = (g.__scaperPageCache ??= new Map());
const TTL_MS = 15 * 60_000;
const MAX = 20;

export function rememberPage(keys: string[], html: string, url: string) {
  for (const k of keys) cache.set(k, { html, url, at: Date.now() });
  while (cache.size > MAX) cache.delete(cache.keys().next().value!);
}

export function cachedPage(key: string): Entry | null {
  const e = cache.get(key);
  if (!e || Date.now() - e.at > TTL_MS) return null;
  return e;
}

const pending = new Map<string, Promise<Entry>>();

/**
 * The cached page, or one fetch shared by everyone asking at the same time (the selector
 * builder checks several fields at once; they should cause one page load, not five).
 */
export async function pageFor(key: string, load: () => Promise<{ html: string; finalUrl: string }>): Promise<Entry> {
  const hit = cachedPage(key);
  if (hit) return hit;
  let p = pending.get(key);
  if (!p) {
    p = load().then((page) => {
      rememberPage([key], page.html, page.finalUrl);
      return { html: page.html, url: page.finalUrl, at: Date.now() };
    }).finally(() => pending.delete(key));
    pending.set(key, p);
  }
  return p;
}
