import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { db } from "../db";
import { newId, now } from "./util";

export type ApiToken = { id: string; name: string; prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null };

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

/** Creates a personal API token. The plain value is returned once and never stored. */
export function createToken(name: string): { token: string; record: ApiToken } {
  const token = `scp_${randomBytes(24).toString("base64url")}`;
  const id = newId();
  db().prepare("INSERT INTO api_tokens (id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)").run(id, name, hash(token), token.slice(0, 10), now());
  return { token, record: listTokens().find((t) => t.id === id)! };
}

export function listTokens(): ApiToken[] {
  return db().prepare("SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM api_tokens ORDER BY created_at DESC").all() as ApiToken[];
}

export function revokeToken(id: string) {
  return db().prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now(), id).changes > 0;
}

/** True for a live token; records when it was last used (at most once a minute). */
export function verifyToken(token: string): boolean {
  if (!/^scp_[\w-]{20,}$/.test(token)) return false;
  const r = db().prepare("SELECT id, last_used_at FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL").get(hash(token)) as { id: string; last_used_at: string | null } | undefined;
  if (!r) return false;
  if (!r.last_used_at || Date.now() - Date.parse(r.last_used_at) > 60_000) db().prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now(), r.id);
  return true;
}
