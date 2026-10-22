#!/usr/bin/env node
/**
 * Scaper MCP bridge for AI apps that start local (stdio) servers, such as Claude Desktop.
 * It forwards each JSON-RPC message to Scaper's /api/mcp endpoint with your API token.
 *
 *   SCAPER_URL=http://127.0.0.1:3000 SCAPER_TOKEN=scp_… node scripts/scaper-mcp.mjs
 *
 * No dependencies; Node 20+.
 */
import { createInterface } from "node:readline";

const base = (process.env.SCAPER_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const token = process.env.SCAPER_TOKEN || "";
if (!token) process.stderr.write("scaper-mcp: SCAPER_TOKEN is not set. Create a token in Scaper → Settings → API.\n");

let protocolVersion = null;
const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

async function forward(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
  const ids = (Array.isArray(msg) ? msg : [msg]).map((m) => m && m.id).filter((id) => id !== undefined);
  try {
    const res = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`, ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
      },
      body: line,
    });
    if (res.status === 202) return;
    const text = await res.text();
    let out;
    try { out = JSON.parse(text); } catch { out = null; }
    if (!out || (!out.jsonrpc && !Array.isArray(out))) {
      const message = out?.error?.message || `Scaper answered HTTP ${res.status}`;
      for (const id of ids) write({ jsonrpc: "2.0", id, error: { code: -32000, message } });
      return;
    }
    for (const r of Array.isArray(out) ? out : [out]) {
      if (r.result && r.result.protocolVersion) protocolVersion = r.result.protocolVersion;
      write(r);
    }
  } catch (e) {
    for (const id of ids) write({ jsonrpc: "2.0", id, error: { code: -32000, message: `Can't reach Scaper at ${base}: ${e.message}. Is it running (npm run dev)?` } });
  }
}

const rl = createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on("line", (line) => { if (line.trim()) chain = chain.then(() => forward(line)); });
rl.on("close", () => { void chain.then(() => process.exit(0)); });
