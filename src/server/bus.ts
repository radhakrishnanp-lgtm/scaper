import "server-only";
import { EventEmitter } from "node:events";

export type BusEvent =
  | { type: "notification"; id: string; title: string; body: string; url: string | null; desktop: boolean; kind?: string; event?: string | null; refId?: string | null; botId?: string | null }
  | { type: "task_run"; id: string; recipeId: string; name: string; status: string; rows: number; trigger: string }
  | { type: "bot"; id: string; status: string }
  | { type: "watcher"; id: string; status: string }
  | { type: "product"; id: string }
  | { type: "agent"; id: string; status: string }
  | { type: "job"; id: string; status: string; kind: string; title: string; progress?: Record<string, unknown> }
  | { type: "deal_search"; id: string };

const g = globalThis as unknown as { __scaperBus?: EventEmitter };
const emitter = (g.__scaperBus ??= new EventEmitter().setMaxListeners(100));

/** In-process event bus that feeds the live (SSE) stream in the browser. */
export const bus = {
  emit: (e: BusEvent) => emitter.emit("event", e),
  on: (fn: (e: BusEvent) => void) => { emitter.on("event", fn); return () => emitter.off("event", fn); },
};
