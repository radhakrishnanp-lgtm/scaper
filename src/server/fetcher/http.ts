import "server-only";
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { FetchError } from "./errors";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const g = globalThis as unknown as { __scaperDispatchers?: Map<string, Dispatcher> };
const dispatchers = (g.__scaperDispatchers ??= new Map());

/** A user-set proxy wins; otherwise standard HTTPS_PROXY / NO_PROXY variables are honoured. */
export function dispatcherFor(proxyUrl: string): Dispatcher | undefined {
  const key = proxyUrl || "env";
  if (!dispatchers.has(key)) {
    if (proxyUrl) dispatchers.set(key, new ProxyAgent(proxyUrl));
    else if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY) dispatchers.set(key, new EnvHttpProxyAgent());
    else return undefined;
  }
  return dispatchers.get(key);
}

/** Honours the charset from the Content-Type header or a <meta charset>, defaulting to UTF-8. */
export function decodeBody(buf: Buffer, contentType: string | null): string {
  const head = buf.subarray(0, 2048).toString("latin1");
  const label = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(label.toLowerCase()).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

export type HttpResponse = { status: number; url: string; headers: Headers; text: string };

/**
 * Plain HTTP fetch ("fast mode"): no JavaScript, tiny footprint, follows redirects
 * manually so every hop can be checked by `checkUrl`.
 */
export async function httpGet(
  url: string,
  opts: { userAgent: string; timeoutMs: number; proxyUrl: string; accept?: string; checkUrl?: (u: string) => Promise<void> },
): Promise<HttpResponse> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await opts.checkUrl?.(current);
    let res;
    try {
      res = await undiciFetch(current, {
        redirect: "manual",
        dispatcher: dispatcherFor(opts.proxyUrl),
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: {
          "user-agent": opts.userAgent,
          accept: opts.accept ?? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "accept-language": "en-IN,en;q=0.9",
        },
      });
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError" || err.name === "AbortError") throw new FetchError("timeout", `The page took longer than ${Math.round(opts.timeoutMs / 1000)}s to respond.`);
      throw new FetchError("network", `Could not reach the site: ${(err.cause as Error | undefined)?.message ?? err.message}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current).toString();
      await res.body?.cancel();
      continue;
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) {
      await res.body?.cancel();
      throw new FetchError("too_large", "The page is larger than 10 MB, so it was skipped.");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new FetchError("too_large", "The page is larger than 10 MB, so it was skipped.");
        chunks.push(chunk);
      }
    }
    const text = decodeBody(Buffer.concat(chunks), res.headers.get("content-type"));
    return { status: res.status, url: current, headers: res.headers as unknown as Headers, text };
  }
  throw new FetchError("http", "Too many redirects.");
}
