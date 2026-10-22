import "server-only";

/**
 * Private work lives here instead of the database: in this process's memory only, gone after
 * `ttlMs` (counted from the last write) or when Scaper stops.
 */
export class EphemeralStore<T> {
  private items = new Map<string, { value: T; at: number }>();
  constructor(private ttlMs: number, private max = 200) {}

  set(id: string, value: T) {
    this.sweep();
    this.items.delete(id);
    this.items.set(id, { value, at: Date.now() });
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value!);
    return value;
  }

  get(id: string): T | null {
    const e = this.items.get(id);
    if (!e) return null;
    if (Date.now() - e.at > this.ttlMs) { this.items.delete(id); return null; }
    return e.value;
  }

  has(id: string) { return this.get(id) !== null; }
  delete(id: string) { return this.items.delete(id); }
  clear() { const n = this.items.size; this.items.clear(); return n; }

  values(): T[] {
    this.sweep();
    return [...this.items.values()].map((e) => e.value).reverse();
  }

  private sweep() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [k, e] of this.items) if (e.at < cutoff) this.items.delete(k);
  }
}

const g = globalThis as unknown as { __scaperEphemeral?: Map<string, EphemeralStore<unknown>> };
const stores = (g.__scaperEphemeral ??= new Map());

/** One store per name that survives dev hot reloads. */
export function ephemeral<T>(name: string, ttlMs: number, max?: number): EphemeralStore<T> {
  let s = stores.get(name);
  if (!s) { s = new EphemeralStore<T>(ttlMs, max); stores.set(name, s); }
  return s as EphemeralStore<T>;
}

/** "Forget everything private now" (Settings → Privacy). */
export function clearEphemeral() {
  let n = 0;
  for (const s of stores.values()) n += s.clear();
  return n;
}
