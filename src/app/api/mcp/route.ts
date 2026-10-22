import { NextResponse } from "next/server";
import { handler, HttpError, rateLimit } from "@/server/api";
import { handleMcp, MCP_PROTOCOL_VERSIONS } from "@/server/mcp/server";
import { getSettings } from "@/server/repo/settings";

export const dynamic = "force-dynamic";

/**
 * MCP endpoint (Streamable HTTP, stateless JSON responses). Connect AI apps with an API token:
 *   claude mcp add --transport http scaper http://127.0.0.1:3000/api/mcp --header "Authorization: Bearer scp_…"
 * or use scripts/scaper-mcp.mjs for apps that only start local (stdio) servers.
 */
export const POST = handler(async (req) => {
  if (!getSettings().integrations.mcpEnabled) throw new HttpError(403, "mcp_disabled", "The MCP server is turned off in Integrations → MCP.");
  rateLimit("mcp", 120, 30);
  let body: unknown;
  try { body = JSON.parse(await req.text()); } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  const version = req.headers.get("mcp-protocol-version");
  if (version && !MCP_PROTOCOL_VERSIONS.includes(version)) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `Unsupported protocol version ${version}` } }, { status: 400 });
  }
  const messages = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(messages.map((m) => handleMcp(m as never, req.signal)))).filter((r) => r !== null);
  if (!replies.length) return new Response(null, { status: 202 });
  return NextResponse.json(Array.isArray(body) ? replies : replies[0]);
});

/** No server-initiated stream: this server only answers requests. */
export const GET = handler(async () => new Response(null, { status: 405, headers: { allow: "POST" } }));
export const DELETE = handler(async () => new Response(null, { status: 405, headers: { allow: "POST" } }));
