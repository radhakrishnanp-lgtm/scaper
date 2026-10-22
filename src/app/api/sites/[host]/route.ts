import { z } from "zod";
import { handler, notFound } from "@/server/api";
import { audit } from "@/server/repo/events";
import { deleteSiteRule, hostDaily } from "@/server/repo/sites";

type Ctx = { params: Promise<{ host: string }> };
const hostParam = z.string().toLowerCase().regex(/^[a-z0-9.-]+$/);

export const GET = handler(async (_req, { params }: Ctx) => ({ daily: hostDaily(hostParam.parse((await params).host), 30) }));

export const DELETE = handler(async (_req, { params }: Ctx) => {
  const host = hostParam.parse((await params).host);
  if (!deleteSiteRule(host)) throw notFound("Site rule");
  audit("site.rule_deleted", { host });
  return { ok: true };
});
