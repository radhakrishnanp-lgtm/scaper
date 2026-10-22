import { z } from "zod";
import { handler } from "@/server/api";
import { resetHost } from "@/server/fetcher/politeness";
import { audit } from "@/server/repo/events";

/** Clears the automatic backoff for a site, after you checked it in your own browser. */
export const POST = handler(async (_req, { params }: { params: Promise<{ host: string }> }) => {
  const host = z.string().toLowerCase().regex(/^[a-z0-9.-]+$/).parse((await params).host);
  const ok = resetHost(host);
  audit("site.backoff_reset", { host });
  return { ok };
});
