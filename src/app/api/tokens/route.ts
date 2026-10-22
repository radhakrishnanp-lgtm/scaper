import { handler, readJson } from "@/server/api";
import { audit } from "@/server/repo/events";
import { createToken, listTokens } from "@/server/repo/tokens";
import { apiTokenSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const GET = handler(async () => ({ tokens: listTokens() }));

/** The token is shown once in the response; only its hash is stored. */
export const POST = handler(async (req) => {
  const { name } = await readJson(req, apiTokenSchema);
  const out = createToken(name);
  audit("token.created", { id: out.record.id, name });
  return out;
});
