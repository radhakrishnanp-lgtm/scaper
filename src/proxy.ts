import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session-token";

const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/health"];

function allowedHosts() {
  const extra = (process.env.SCAPER_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return new Set(["localhost", "127.0.0.1", "[::1]", ...extra]);
}

function deny(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message, requestId: crypto.randomUUID() } }, { status });
}

/**
 * Runs before every request:
 * 1. Host check: blocks DNS-rebinding attacks against a locally running app.
 * 2. Origin check on writes: other websites open in your browser cannot call Scaper's API.
 * 3. Optional password: when SCAPER_APP_PASSWORD is set, every page and API needs a valid session.
 */
export async function proxy(req: NextRequest) {
  const host = (req.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  if (!allowedHosts().has(host)) return deny(421, "host_not_allowed", "This host name is not allowed. Add it to SCAPER_ALLOWED_HOSTS.");

  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");
  if (isApi && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.headers.get("origin");
    let originHost = "";
    try { originHost = origin ? new URL(origin).host.toLowerCase() : ""; } catch { originHost = "invalid"; }
    if (!origin || originHost !== (req.headers.get("host") ?? "").toLowerCase()) {
      return deny(403, "bad_origin", "Cross-site requests are not allowed.");
    }
  }

  const password = process.env.SCAPER_APP_PASSWORD;
  if (!password || PUBLIC_PATHS.some((p) => pathname === p)) return NextResponse.next();
  const ok = await verifySessionToken(process.env.SCAPER_SESSION_SECRET ?? "", req.cookies.get(SESSION_COOKIE)?.value);
  if (ok) return NextResponse.next();
  if (isApi) return deny(401, "unauthorized", "Please log in.");
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)"],
};
