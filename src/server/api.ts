import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AiError } from "./ai/client";
import { FetchError } from "./fetcher/errors";
import { log } from "./log";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const notFound = (what = "Item") => new HttpError(404, "not_found", `${what} not found.`);

const MAX_BODY_BYTES = 256 * 1024;

export async function readJson<T extends z.ZodType>(req: NextRequest, schema: T): Promise<z.infer<T>> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "Request body is too large.");
  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "Request body is too large.");
    body = text ? JSON.parse(text) : {};
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "bad_json", "The request body is not valid JSON.");
  }
  return schema.parse(body);
}

const AI_STATUS: Record<AiError["code"], number> = { not_configured: 400, quota: 429, upstream: 502, timeout: 504, bad_output: 502 };

/** Wraps a route handler: one error format, correct status codes, a request ID, and no stack traces in responses. */
export function handler<C>(fn: (req: NextRequest, ctx: C) => Promise<Response | unknown>) {
  return async (req: NextRequest, ctx: C) => {
    const requestId = randomUUID();
    try {
      const out = await fn(req, ctx);
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (e) {
      let status = 500;
      let code = "internal";
      let message = "Something went wrong on our side. Check the server log for details.";
      let fields: Record<string, string> | undefined;
      if (e instanceof z.ZodError) {
        status = 400; code = "validation"; message = "Please fix the highlighted fields.";
        fields = Object.fromEntries(e.issues.map((i) => [i.path.join(".") || "_", i.message]));
      } else if (e instanceof HttpError) {
        status = e.status; code = e.code; message = e.message;
      } else if (e instanceof AiError) {
        status = AI_STATUS[e.code]; code = `ai_${e.code}`; message = e.message;
      } else if (e instanceof FetchError) {
        status = 422; code = `fetch_${e.code}`; message = e.message;
      } else {
        log.error("api.unhandled", { requestId, path: req.nextUrl.pathname, error: e as Error });
      }
      return NextResponse.json({ error: { code, message, requestId, fields } }, { status, headers: { "x-request-id": requestId } });
    }
  };
}

type Bucket = { tokens: number; at: number };
const g = globalThis as unknown as { __scaperBuckets?: Map<string, Bucket> };
const buckets = (g.__scaperBuckets ??= new Map());

/**
 * In-memory token bucket. Fine for a single local process; move it to Redis when Scaper runs on several servers.
 * `perMinute` requests refill evenly over a minute, with bursts up to `burst`.
 */
export function rateLimit(key: string, perMinute: number, burst = perMinute) {
  const nowMs = Date.now();
  const b = buckets.get(key) ?? { tokens: burst, at: nowMs };
  b.tokens = Math.min(burst, b.tokens + ((nowMs - b.at) / 60_000) * perMinute);
  b.at = nowMs;
  if (b.tokens < 1) {
    const wait = Math.ceil(((1 - b.tokens) / perMinute) * 60);
    buckets.set(key, b);
    throw new HttpError(429, "rate_limited", `Too many requests. Try again in ${wait}s.`);
  }
  b.tokens -= 1;
  buckets.set(key, b);
}

export const clientKey = (req: NextRequest) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";

export const idParam = z.string().uuid("Invalid id");
