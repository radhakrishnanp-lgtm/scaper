import "server-only";
import { randomUUID } from "node:crypto";

export const newId = () => randomUUID();
export const now = () => new Date().toISOString();

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Keyset pagination helper: clamps the page size so no query reads a whole table. */
export function pageSize(limit: number | undefined, max = 100, def = 25) {
  if (!limit || !Number.isFinite(limit)) return def;
  return Math.min(Math.max(1, Math.floor(limit)), max);
}
