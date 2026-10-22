import "server-only";
import robotsParser from "robots-parser";

/**
 * Polite-crawling rules shared by both fetch modes:
 * one request at a time per host, a minimum gap between requests (with jitter),
 * robots.txt, and exponential backoff when a site says "slow down" (429/503) or shows a bot check.
 */

type HostState = { nextAt: number; chain: Promise<void>; penalty: number; blockedUntil: number };
const g = globalThis as unknown as {
  __scaperHosts?: Map<string, HostState>;
  __scaperRobots?: Map<string, { robot: ReturnType<typeof robotsParser> | null; disallowAll: boolean; at: number }>;
};
const hosts = (g.__scaperHosts ??= new Map());
const robotsCache = (g.__scaperRobots ??= new Map());

const ROBOTS_TTL_MS = 60 * 60_000;
const MAX_PENALTY = 6; // 2^6 = 64x the base delay

function state(host: string): HostState {
  let s = hosts.get(host);
  if (!s) {
    s = { nextAt: 0, chain: Promise.resolve(), penalty: 0, blockedUntil: 0 };
    hosts.set(host, s);
  }
  return s;
}

export function hostBlockedFor(host: string): number {
  return Math.max(0, state(host).blockedUntil - Date.now());
}

/**
 * Runs `task` when it is this host's turn. Calls for the same host queue up;
 * different hosts run in parallel.
 */
export function withHostTurn<T>(host: string, baseDelayMs: number, task: () => Promise<T>): Promise<T> {
  const s = state(host);
  const run = s.chain.then(async () => {
    const delay = baseDelayMs * 2 ** s.penalty;
    const jitter = delay * (Math.random() * 0.4 - 0.2);
    const wait = Math.max(0, s.nextAt - Date.now(), s.blockedUntil - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await task();
    } finally {
      s.nextAt = Date.now() + delay + jitter;
    }
  });
  s.chain = run.then(() => undefined, () => undefined);
  return run;
}

/** Call after 429/503 or a bot check: doubles the gap and pauses the host. */
export function penalize(host: string, retryAfterSeconds?: number) {
  const s = state(host);
  s.penalty = Math.min(MAX_PENALTY, s.penalty + 1);
  const pauseMs = retryAfterSeconds && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 60_000 * 2 ** (s.penalty - 1);
  s.blockedUntil = Date.now() + Math.min(pauseMs, 6 * 60 * 60_000);
}

/** Call after a clean response: slowly forgives earlier penalties. */
export function reward(host: string) {
  const s = state(host);
  if (s.penalty > 0) s.penalty -= 1;
}

export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : undefined;
}

export type RobotsVerdict = { allowed: boolean; crawlDelaySeconds?: number };

/** Loads robots.txt (cached for an hour). A missing file allows everything; a 5xx disallows for now, as search engines do. */
export async function checkRobots(
  url: string,
  userAgent: string,
  fetchText: (u: string) => Promise<{ status: number; text: string }>,
): Promise<RobotsVerdict> {
  const u = new URL(url);
  const origin = u.origin;
  let entry = robotsCache.get(origin);
  if (!entry || Date.now() - entry.at > ROBOTS_TTL_MS) {
    const robotsUrl = `${origin}/robots.txt`;
    try {
      const res = await fetchText(robotsUrl);
      if (res.status >= 200 && res.status < 300) entry = { robot: robotsParser(robotsUrl, res.text), disallowAll: false, at: Date.now() };
      else if (res.status >= 500) entry = { robot: null, disallowAll: true, at: Date.now() - ROBOTS_TTL_MS + 5 * 60_000 };
      else entry = { robot: null, disallowAll: false, at: Date.now() };
    } catch {
      entry = { robot: null, disallowAll: false, at: Date.now() - ROBOTS_TTL_MS + 5 * 60_000 };
    }
    robotsCache.set(origin, entry);
  }
  if (entry.disallowAll) return { allowed: false };
  if (!entry.robot) return { allowed: true };
  const allowed = entry.robot.isAllowed(url, userAgent) !== false;
  return { allowed, crawlDelaySeconds: entry.robot.getCrawlDelay(userAgent) };
}

const BOT_WALL_MARKERS: [RegExp, string][] = [
  [/validateCaptcha|Enter the characters you see below|api-services-support@amazon\.com/i, "Amazon showed a robot check"],
  [/g-recaptcha|recaptcha\/api\.js/i, "The page shows a reCAPTCHA"],
  [/hcaptcha\.com\/1\/api\.js|h-captcha/i, "The page shows an hCaptcha"],
  [/cf-chl-|challenge-platform|Just a moment\.\.\.|Attention Required! \| Cloudflare/i, "Cloudflare is checking the visitor"],
  [/px-captcha|perimeterx/i, "The site's bot protection blocked the request"],
  [/<title>\s*(Access Denied|Robot Check|Are you a robot\??)\s*<\/title>/i, "The site denied automated access"],
];

/** Detects a CAPTCHA or bot-check page. Scaper stops here; it never tries to solve or bypass these. */
export function detectBotWall(html: string, status: number): string | null {
  const head = html.slice(0, 200_000);
  for (const [re, reason] of BOT_WALL_MARKERS) if (re.test(head)) return reason;
  if (status === 429) return "The site says too many requests (429)";
  return null;
}

/** Live backoff state per host, for the Sites page. */
export function hostStates() {
  return [...hosts.entries()].map(([host, s]) => ({ host, penalty: s.penalty, blockedForMs: Math.max(0, s.blockedUntil - Date.now()) }));
}

/** Lets a host be tried again right away (after the user checked it in their own browser). */
export function resetHost(host: string) {
  const s = hosts.get(host);
  if (!s) return false;
  s.penalty = 0;
  s.blockedUntil = 0;
  return true;
}
