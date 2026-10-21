import { timingSafeEqual, createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { clientKey, handler, HttpError, rateLimit, readJson } from "@/server/api";
import { env } from "@/server/env";
import { audit } from "@/server/repo/events";
import { loginSchema } from "@/lib/schemas";
import { createSessionToken, SESSION_COOKIE, SESSION_DAYS } from "@/lib/session-token";

const digest = (s: string) => createHash("sha256").update(s).digest();

export const POST = handler(async (req) => {
  // 10 attempts per 15 minutes per client.
  rateLimit(`login:${clientKey(req)}`, 10 / 15, 10);
  if (!env.SCAPER_APP_PASSWORD) throw new HttpError(400, "no_password", "This Scaper has no password set.");
  const { password } = await readJson(req, loginSchema);
  if (!timingSafeEqual(digest(password), digest(env.SCAPER_APP_PASSWORD))) {
    audit("auth.login_failed", { client: clientKey(req) }, "warn");
    throw new HttpError(401, "bad_password", "That password is not correct.");
  }
  audit("auth.login", { client: clientKey(req) });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await createSessionToken(env.SCAPER_SESSION_SECRET), {
    httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", path: "/", maxAge: SESSION_DAYS * 86400,
  });
  return res;
});
