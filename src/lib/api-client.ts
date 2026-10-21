"use client";

import type { ApiError } from "./types";

export class ClientApiError extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>, public requestId?: string) {
    super(message);
  }
}

/** JSON fetch for the browser. Throws ClientApiError with the server's friendly message. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
      cache: "no-store",
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ClientApiError(0, "offline", "Can't reach Scaper. Is `npm run dev` still running?");
  }
  if (res.status === 401) {
    // Session expired: a full navigation resets client state before logging in again.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new ClientApiError(401, "unauthorized", "Please log in.");
  }
  const data = (await res.json().catch(() => null)) as T | ApiError | null;
  if (!res.ok) {
    const err = (data as ApiError | null)?.error;
    throw new ClientApiError(res.status, err?.code ?? "error", err?.message ?? `Request failed (${res.status}).`, err?.fields, err?.requestId);
  }
  return data as T;
}

export function errorText(e: unknown) {
  return e instanceof Error ? e.message : "Something went wrong.";
}
