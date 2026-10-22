"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** A string kept in the URL (?tab=…), so tabs and filters survive reloads and can be linked to. */
export function useQueryState<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const value = (params.get(key) as T | null) ?? fallback;
  const set = useCallback((v: T) => {
    const next = new URLSearchParams(window.location.search);
    if (v === fallback || v === "") next.delete(key); else next.set(key, v);
    const qs = next.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [key, fallback, pathname, router]);
  return [value, set];
}
