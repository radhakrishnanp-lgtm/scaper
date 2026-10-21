"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "./api-client";

/** Tiny data hook: loading / error / data, with reload and optional polling. */
export function useApi<T>(path: string | null, opts: { pollMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const ctrl = useRef<AbortController | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!path) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    if (!quiet) setLoading(true);
    try {
      const d = await api<T>(path, { signal: c.signal });
      setData(d);
      setError(null);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(errorText(e));
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    // Initial fetch for this path; state updates happen after the request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => ctrl.current?.abort();
  }, [load]);

  useEffect(() => {
    if (!opts.pollMs) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(true); }, opts.pollMs);
    return () => clearInterval(t);
  }, [load, opts.pollMs]);

  useEffect(() => {
    const onLive = () => void load(true);
    window.addEventListener("scaper:live", onLive);
    return () => window.removeEventListener("scaper:live", onLive);
  }, [load]);

  return { data, error, loading, reload: () => load(true), setData };
}
