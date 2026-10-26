import { subscribe } from "@/server/live-browser/session";

export const dynamic = "force-dynamic";

/** Server-Sent Events: the live picture of the active tab (JPEG frames), tab state, dialogs and notices. */
export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      // A slow connection skips frames instead of queueing them: only the newest picture matters.
      let pendingFrame: string | null = null;
      let flushing = false;
      const write = (s: string) => { try { controller.enqueue(encoder.encode(s)); } catch { cleanup(); } };
      const flush = () => {
        if (flushing) return;
        flushing = true;
        setImmediate(() => { flushing = false; if (pendingFrame) { const f = pendingFrame; pendingFrame = null; write(f); } });
      };
      const off = subscribe((e) => {
        if (e.type === "frame") {
          pendingFrame = `event: frame\ndata: ${JSON.stringify(e.frame)}\n\n`;
          if ((controller.desiredSize ?? 1) > 0) flush();
        } else write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      });
      const ping = setInterval(() => write(": ping\n\n"), 20_000);
      cleanup = () => { off(); clearInterval(ping); };
      req.signal.addEventListener("abort", () => { cleanup(); try { controller.close(); } catch { /* already closed */ } });
    },
    pull() { /* the next frame goes out when it arrives */ },
    cancel() { cleanup(); },
  }, { highWaterMark: 2 });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
