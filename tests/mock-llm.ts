import http from "node:http";
import type { AddressInfo } from "node:net";

type Msg = { role: string; content: string | null; tool_calls?: unknown[] };

/**
 * A fake OpenAI-compatible server. `script` decides each reply from the conversation so far,
 * which lets tests drive the agent's tool loop deterministically.
 */
export function startMockLlm(script: (messages: Msg[], body: Record<string, unknown>) => Record<string, unknown>) {
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push({ ...body, auth: req.headers.authorization });
      const message = script(body.messages as Msg[], body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    });
  });
  return new Promise<{ base: string; requests: typeof requests; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
