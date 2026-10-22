import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-operation context that follows async calls: whether the work is private (nothing may be
 * written to disk) and what an AI call is for, so the AI log can say "extraction for run X".
 */
export type WorkContext = { private?: boolean; purpose?: string; refId?: string | null };

const g = globalThis as unknown as { __scaperWorkCtx?: AsyncLocalStorage<WorkContext> };
const als = (g.__scaperWorkCtx ??= new AsyncLocalStorage<WorkContext>());

export function withWork<T>(ctx: WorkContext, fn: () => T): T {
  const parent = als.getStore() ?? {};
  // Private is sticky: nested work inside a private operation stays private.
  return als.run({ ...parent, ...ctx, private: Boolean(parent.private || ctx.private) }, fn);
}

export const isPrivate = () => als.getStore()?.private ?? false;
export const workContext = (): WorkContext => als.getStore() ?? {};
