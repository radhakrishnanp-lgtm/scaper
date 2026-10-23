import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/api";
import { assertPublicUrl } from "@/server/fetcher/network-guard";
import { dispatcherFor, httpGet } from "@/server/fetcher/http";
import { DEFAULT_FAST_UA } from "@/server/fetcher";
import { getSettings } from "@/server/repo/settings";
import { urlSchema } from "@/lib/schemas";

const schema = z.object({ url: urlSchema.default("https://example.com/") });

/** Loads one page through the saved network route (your proxy or VPN app, the HTTPS_PROXY variables, or direct). */
export const POST = handler(async (req) => {
  rateLimit("settings:network", 10, 3);
  const { url } = await readJson(req, schema);
  const s = getSettings().scraping;
  const route = s.proxyUrl ? (/^socks/i.test(s.proxyUrl) ? "socks5" : "http-proxy") : dispatcherFor("") ? "env-proxy" : "direct";
  const aiRoute = s.proxyAi && s.proxyUrl ? route : dispatcherFor("") ? "env-proxy" : "direct";
  const started = Date.now();
  try {
    const res = await httpGet(url, { userAgent: s.userAgent || DEFAULT_FAST_UA, timeoutMs: 15_000, proxyUrl: s.proxyUrl, checkUrl: (u) => assertPublicUrl(u, s.allowPrivateNetwork), signal: req.signal });
    return { ok: res.status < 400, status: res.status, ms: Date.now() - started, route, finalUrl: res.url, aiRoute };
  } catch (e) {
    return { ok: false, status: null, ms: Date.now() - started, route, error: (e as Error).message, aiRoute };
  }
});
