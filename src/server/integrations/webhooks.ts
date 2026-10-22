import "server-only";
import { createHmac } from "node:crypto";
import { fetch as undiciFetch } from "undici";
import type { WebhookEndpoint } from "@/lib/schemas";
import { env } from "../env";
import { dispatcherFor } from "../fetcher/http";
import { isPrivate } from "../privacy";
import { addDelivery, dueDeliveries, getDelivery, recordAttempt, type Delivery } from "../repo/deliveries";
import { audit } from "../repo/events";
import { getSettings } from "../repo/settings";

export type WebhookEvent = WebhookEndpoint["events"][number];

/** Backoff between attempts (Svix-style, shortened for one machine): 30 s, 2 min, 10 min, 1 h, 6 h. */
export const RETRY_SCHEDULE_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];

type Target = { id: string; name: string; url: string; secret: string };

/** Every endpoint that wants this event: the default webhook URL (all events) plus your named endpoints. */
export function endpointsFor(event: WebhookEvent): Target[] {
  const s = getSettings();
  const out: Target[] = [];
  if (s.notifications.webhookUrl) out.push({ id: "default", name: "Default webhook", url: s.notifications.webhookUrl, secret: env.SCAPER_SESSION_SECRET });
  for (const w of s.integrations.webhooks) if (w.enabled && w.events.includes(event)) out.push({ id: w.id, name: w.name, url: w.url, secret: w.secret });
  return out;
}

const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

async function post(t: Pick<Target, "url" | "secret">, event: string, deliveryId: string | null, payload: unknown) {
  const body = JSON.stringify(payload);
  const started = Date.now();
  const res = await undiciFetch(t.url, {
    method: "POST",
    dispatcher: dispatcherFor(""),
    signal: AbortSignal.timeout(10_000),
    headers: {
      "content-type": "application/json", "user-agent": "Scaper-Webhook/1.0", "x-scaper-event": event,
      ...(deliveryId ? { "x-scaper-delivery": deliveryId } : {}),
      ...(t.secret ? { "x-scaper-signature": sign(t.secret, body) } : {}),
    },
    body,
  });
  const text = (await res.text().catch(() => "")).slice(0, 4000);
  return { ok: res.ok, code: res.status, body: text, ms: Date.now() - started };
}

async function attempt(d: Pick<Delivery, "id" | "attempts" | "event" | "payload" | "url">, secret: string) {
  const retries = getSettings().integrations.webhookRetries;
  try {
    const r = await post({ url: d.url, secret }, d.event, d.id, d.payload);
    if (r.ok) { recordAttempt(d.id, { status: "ok", code: r.code, body: r.body, ms: r.ms }); return { ok: true as const }; }
    throw Object.assign(new Error(`HTTP ${r.code}: ${r.body.slice(0, 200)}`), { code: r.code, body: r.body, ms: r.ms });
  } catch (e) {
    const err = e as Error & { code?: number; body?: string; ms?: number };
    const n = d.attempts + 1;
    const delay = RETRY_SCHEDULE_MS[n - 1];
    const retry = retries && delay !== undefined;
    recordAttempt(d.id, {
      status: retry ? "retrying" : "failed", code: typeof err.code === "number" ? err.code : null, body: err.body ?? null,
      error: err.name === "TimeoutError" ? "Timed out after 10 s" : err.message, ms: err.ms ?? null,
      nextAt: retry ? new Date(Date.now() + delay).toISOString() : null,
    });
    return { ok: false as const, error: err.message, retrying: retry };
  }
}

const secretFor = (target: string) =>
  target === "default" ? env.SCAPER_SESSION_SECRET : getSettings().integrations.webhooks.find((w) => w.id === target)?.secret ?? "";

/**
 * Sends an event to every subscribed endpoint. Each attempt is logged with its response, and failures are retried
 * with backoff. Private work is sent but not logged. Throws only when no endpoint is set up (or `strict` and all failed).
 */
export async function emitWebhook(event: WebhookEvent, data: Record<string, unknown>, opts: { refId?: string | null; strict?: boolean; name?: string } = {}) {
  const targets = endpointsFor(event);
  if (!targets.length) throw new Error("No webhook URL set. Add one in Integrations → Webhooks or Settings → Alerts.");
  // `name` keeps the event names older receivers already know (scaper.watcher, scaper.price …).
  const payload = { event: opts.name ?? `scaper.${event}`, ...data, sentAt: new Date().toISOString() };
  const results = await Promise.all(targets.map(async (t) => {
    if (isPrivate()) {
      const r = await post(t, payload.event, null, payload).catch((e: Error) => ({ ok: false, code: 0, body: e.message, ms: 0 }));
      return { target: t.name, ok: r.ok, error: r.ok ? undefined : `HTTP ${r.code}: ${r.body}`.slice(0, 200), retrying: false };
    }
    const id = addDelivery({ kind: "webhook", target: t.id, targetName: t.name, event, url: t.url, payload, refId: opts.refId });
    const r = await attempt({ id, attempts: 0, event: payload.event, payload, url: t.url }, t.secret);
    return { target: t.name, ok: r.ok, error: r.ok ? undefined : r.error, retrying: r.ok ? false : r.retrying };
  }));
  const failed = results.filter((r) => !r.ok);
  if (failed.length) audit("webhook.failed", { event, targets: failed.map((f) => f.target), retrying: failed.some((f) => f.retrying) }, "warn");
  if (opts.strict && failed.length === results.length) throw new Error(failed.map((f) => `${f.target}: ${f.error}`).join("; "));
  return results;
}

/** Scheduler: retry deliveries whose next attempt is due. */
export async function processDueDeliveries() {
  const due = dueDeliveries(10).filter((d) => d.kind === "webhook");
  for (const d of due) await attempt({ ...d, event: (d.payload as { event?: string } | null)?.event ?? d.event }, secretFor(d.target));
  return due.length;
}

/** "Redeliver": send the same payload again now, as a new attempt on the same delivery. */
export async function redeliver(id: string) {
  const d = getDelivery(id);
  if (!d || d.kind !== "webhook") return null;
  const r = await attempt({ ...d, event: (d.payload as { event?: string } | null)?.event ?? d.event }, secretFor(d.target));
  return { delivery: getDelivery(id)!, ok: r.ok };
}

/** Settings → Test for one endpoint (not logged as a delivery). */
export async function testEndpoint(t: Pick<Target, "url" | "secret">) {
  const r = await post(t, "scaper.test", null, { event: "scaper.test", message: "If you can read this, Scaper can reach this endpoint.", sentAt: new Date().toISOString() });
  if (!r.ok) throw new Error(`HTTP ${r.code}: ${r.body.slice(0, 200)}`);
  return r;
}
