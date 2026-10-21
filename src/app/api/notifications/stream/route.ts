import { bus } from "@/server/bus";

export const dynamic = "force-dynamic";

/** Server-Sent Events: pushes new alerts and status changes to open tabs. */
export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      send({ type: "hello" });
      const off = bus.on(send);
      const ping = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 25_000);
      cleanup = () => { off(); clearInterval(ping); };
      req.signal.addEventListener("abort", () => { cleanup(); try { controller.close(); } catch { /* already closed */ } });
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
}
