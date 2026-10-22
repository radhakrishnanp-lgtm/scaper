import { handler, idParam, notFound } from "@/server/api";
import { audit } from "@/server/repo/events";
import { revokeToken } from "@/server/repo/tokens";

export const DELETE = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const id = idParam.parse((await params).id);
  if (!revokeToken(id)) throw notFound("Token");
  audit("token.revoked", { id });
  return { ok: true };
});
