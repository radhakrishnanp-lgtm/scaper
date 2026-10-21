import { NextResponse } from "next/server";
import { handler } from "@/server/api";
import { SESSION_COOKIE } from "@/lib/session-token";

export const POST = handler(async () => {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
});
