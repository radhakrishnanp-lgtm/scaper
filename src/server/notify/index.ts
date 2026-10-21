import "server-only";
import { createHmac } from "node:crypto";
import { fetch as undiciFetch } from "undici";
import type { NotifyChannels } from "@/lib/schemas";
import { bus } from "../bus";
import { dispatcherFor } from "../fetcher/http";
import { audit } from "../repo/events";
import { addNotification } from "../repo/notifications";
import { getSettings } from "../repo/settings";
import { env } from "../env";

export type Alert = {
  kind: "watcher" | "price" | "agent" | "system";
  title: string; body: string; url?: string | null;
  watcherId?: string | null; productId?: string | null;
  data?: Record<string, unknown>;
};

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await undiciFetch(url, {
    method: "POST",
    dispatcher: dispatcherFor(""),
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function sendWebhook(alert: Alert) {
  const { webhookUrl } = getSettings().notifications;
  if (!webhookUrl) throw new Error("No webhook URL set in Settings → Notifications.");
  const payload = { event: `scaper.${alert.kind}`, title: alert.title, body: alert.body, url: alert.url ?? null, data: alert.data ?? {}, sentAt: new Date().toISOString() };
  // Signed with the session secret when one exists, so the receiver can verify the sender.
  const secret = env.SCAPER_SESSION_SECRET;
  const signature = secret ? createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex") : undefined;
  await post(webhookUrl, payload, signature ? { "x-scaper-signature": signature } : {});
}

export async function sendTelegram(alert: Alert) {
  const { telegramBotToken, telegramChatId } = getSettings().notifications;
  if (!telegramBotToken || !telegramChatId) throw new Error("Add a Telegram bot token and chat ID in Settings → Notifications.");
  const text = `*${escapeMd(alert.title)}*\n${escapeMd(alert.body.slice(0, 3000))}${alert.url ? `\n${escapeMd(alert.url)}` : ""}`;
  await post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, { chat_id: telegramChatId, text, parse_mode: "MarkdownV2", disable_web_page_preview: true });
}

const escapeMd = (s: string) => s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");

/**
 * Delivers an alert: always to the in-app inbox (and the live stream, which
 * shows a desktop notification while Scaper is open), plus any external channels.
 * A failing channel never blocks the others.
 */
export async function deliver(alert: Alert, channels: NotifyChannels) {
  const n = addNotification(alert);
  bus.emit({ type: "notification", id: n.id, title: n.title, body: n.body, url: n.url, desktop: channels.desktop });
  const tasks: [string, () => Promise<void>][] = [];
  if (channels.webhook) tasks.push(["webhook", () => sendWebhook(alert)]);
  if (channels.telegram) tasks.push(["telegram", () => sendTelegram(alert)]);
  const results = await Promise.allSettled(tasks.map(([, fn]) => fn()));
  results.forEach((r, i) => {
    const channel = tasks[i]![0];
    if (r.status === "rejected") audit("notify.failed", { channel, error: (r.reason as Error).message }, "warn");
    else audit("notify.sent", { channel, kind: alert.kind });
  });
  return n;
}
