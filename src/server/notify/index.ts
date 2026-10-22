import "server-only";
import { createHmac } from "node:crypto";
import nodemailer from "nodemailer";
import { fetch as undiciFetch } from "undici";
import type { NotifyChannels, Settings } from "@/lib/schemas";
import { bus } from "../bus";
import { dispatcherFor } from "../fetcher/http";
import { audit } from "../repo/events";
import { addNotification } from "../repo/notifications";
import { getSettings } from "../repo/settings";
import { env } from "../env";

export type Alert = {
  kind: "watcher" | "price" | "agent" | "system" | "task" | "deal";
  title: string; body: string; url?: string | null;
  watcherId?: string | null; productId?: string | null;
  data?: Record<string, unknown>;
  /** Optional screenshot (PNG/JPEG bytes) attached where the channel supports it. */
  image?: Buffer | null;
};

export type ExternalChannel = Exclude<keyof NotifyChannels, "desktop">;

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

/** Signed with the session secret when one exists, so the receiver can verify the sender. */
export async function sendWebhookPayload(payload: Record<string, unknown>) {
  const { webhookUrl } = getSettings().notifications;
  if (!webhookUrl) throw new Error("No webhook URL set in Settings → Alerts.");
  const body = { ...payload, sentAt: new Date().toISOString() };
  const secret = env.SCAPER_SESSION_SECRET;
  const signature = secret ? createHmac("sha256", secret).update(JSON.stringify(body)).digest("hex") : undefined;
  await post(webhookUrl, body, signature ? { "x-scaper-signature": signature } : {});
}

export async function sendWebhook(alert: Alert) {
  await sendWebhookPayload({ event: `scaper.${alert.kind}`, title: alert.title, body: alert.body, url: alert.url ?? null, data: alert.data ?? {} });
}

const escapeMd = (s: string) => s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");

export async function sendTelegram(alert: Alert) {
  const { telegramBotToken, telegramChatId } = getSettings().notifications;
  if (!telegramBotToken || !telegramChatId) throw new Error("Add a Telegram bot token and chat ID in Settings → Alerts.");
  const text = `*${escapeMd(alert.title)}*\n${escapeMd(alert.body.slice(0, 3000))}${alert.url ? `\n${escapeMd(alert.url)}` : ""}`;
  await post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, { chat_id: telegramChatId, text, parse_mode: "MarkdownV2", disable_web_page_preview: true });
}

export async function sendDiscord(alert: Alert) {
  const { discordWebhookUrl } = getSettings().notifications;
  if (!discordWebhookUrl) throw new Error("Add a Discord webhook URL in Settings → Alerts.");
  await post(discordWebhookUrl, {
    username: "Scaper",
    embeds: [{ title: alert.title.slice(0, 256), description: alert.body.slice(0, 3900), url: alert.url ?? undefined, color: 0x0f766e, timestamp: new Date().toISOString() }],
  });
}

export async function sendSlack(alert: Alert) {
  const { slackWebhookUrl } = getSettings().notifications;
  if (!slackWebhookUrl) throw new Error("Add a Slack incoming-webhook URL in Settings → Alerts.");
  const text = `*${alert.title}*\n${alert.body.slice(0, 2900)}${alert.url ? `\n<${alert.url}|Open page>` : ""}`;
  await post(slackWebhookUrl, { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
}

/** ntfy.sh or a self-hosted ntfy server: a phone push without any account. */
export async function sendNtfy(alert: Alert) {
  const { ntfyUrl, ntfyToken } = getSettings().notifications;
  if (!ntfyUrl) throw new Error("Add an ntfy topic URL (for example https://ntfy.sh/your-topic) in Settings → Alerts.");
  const res = await undiciFetch(ntfyUrl, {
    method: "POST",
    dispatcher: dispatcherFor(""),
    signal: AbortSignal.timeout(10_000),
    headers: {
      // Header values must be ASCII; the full title is also in the body.
      title: alert.title.replace(/[^\x20-\x7E]/g, "").slice(0, 200) || "Scaper alert",
      tags: alert.kind === "price" || alert.kind === "deal" ? "moneybag" : "bell",
      ...(alert.url ? { click: alert.url } : {}),
      ...(ntfyToken ? { authorization: `Bearer ${ntfyToken}` } : {}),
    },
    body: `${alert.title}\n${alert.body}`.slice(0, 4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const htmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function sendEmail(alert: Alert) {
  const n = getSettings().notifications;
  if (!n.smtpHost || !n.emailTo) throw new Error("Add an SMTP server and a recipient in Settings → Alerts.");
  const transport = nodemailer.createTransport({
    host: n.smtpHost, port: n.smtpPort, secure: n.smtpSecure,
    auth: n.smtpUser ? { user: n.smtpUser, pass: n.smtpPass } : undefined,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
  });
  const lines = alert.body.split("\n");
  await transport.sendMail({
    from: n.emailFrom || n.smtpUser || "scaper@localhost",
    to: n.emailTo,
    subject: `[Scaper] ${alert.title}`.slice(0, 200),
    text: `${alert.body}${alert.url ? `\n\n${alert.url}` : ""}`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5"><h2 style="font-size:16px;margin:0 0 8px">${htmlEscape(alert.title)}</h2>${lines.map((l) => `<div style="${l.startsWith("+") ? "color:#15803d" : l.startsWith("-") ? "color:#b91c1c" : ""}">${htmlEscape(l) || "&nbsp;"}</div>`).join("")}${alert.url ? `<p><a href="${htmlEscape(alert.url)}">Open page</a></p>` : ""}${alert.image ? '<p><img src="cid:shot" style="max-width:100%;border:1px solid #ddd"/></p>' : ""}<p style="color:#888;font-size:12px">Sent by Scaper on your computer.</p></div>`,
    attachments: alert.image ? [{ filename: "screenshot.png", content: alert.image, cid: "shot" }] : [],
  });
}

const SENDERS: Record<ExternalChannel, (a: Alert) => Promise<void>> = {
  webhook: sendWebhook, telegram: sendTelegram, discord: sendDiscord, slack: sendSlack, ntfy: sendNtfy, email: sendEmail,
};

/** True while quiet hours are on: alerts still reach the inbox, but nothing pings you. */
export function inQuietHours(n: Settings["notifications"], at = new Date()) {
  if (!n.quietHoursEnabled) return false;
  const mins = at.getHours() * 60 + at.getMinutes();
  const [sh, sm] = n.quietStart.split(":").map(Number);
  const [eh, em] = n.quietEnd.split(":").map(Number);
  const start = sh! * 60 + sm!;
  const end = eh! * 60 + em!;
  return start <= end ? mins >= start && mins < end : mins >= start || mins < end;
}

/** Which external channels are configured, for "send to every channel I have set up". */
export function configuredChannels(): NotifyChannels {
  const n = getSettings().notifications;
  return {
    desktop: true, webhook: Boolean(n.webhookUrl), telegram: Boolean(n.telegramBotToken && n.telegramChatId), discord: Boolean(n.discordWebhookUrl),
    slack: Boolean(n.slackWebhookUrl), ntfy: Boolean(n.ntfyUrl), email: Boolean(n.smtpHost && n.emailTo),
  };
}

/**
 * Delivers an alert: always to the in-app inbox (and the live stream, which
 * shows a desktop notification while Scaper is open), plus any external channels.
 * A failing channel never blocks the others.
 */
export async function deliver(alert: Alert, channels: Partial<NotifyChannels>) {
  const settings = getSettings().notifications;
  const quiet = inQuietHours(settings);
  const n = addNotification(alert);
  bus.emit({ type: "notification", id: n.id, title: n.title, body: n.body, url: n.url, desktop: Boolean(channels.desktop) && !quiet && !settings.muteAll });
  if (settings.muteAll) {
    audit("notify.muted", { kind: alert.kind, title: alert.title });
    return n;
  }
  if (quiet) {
    audit("notify.quiet_hours", { kind: alert.kind, title: alert.title });
    return n;
  }
  const tasks = (Object.keys(SENDERS) as ExternalChannel[]).filter((c) => channels[c]).map((c) => [c, () => SENDERS[c](alert)] as const);
  const results = await Promise.allSettled(tasks.map(([, fn]) => fn()));
  results.forEach((r, i) => {
    const channel = tasks[i]![0];
    if (r.status === "rejected") audit("notify.failed", { channel, error: (r.reason as Error).message }, "warn");
    else audit("notify.sent", { channel, kind: alert.kind });
  });
  return n;
}

/** Settings → "Send test" for one channel. */
export async function testChannel(channel: ExternalChannel) {
  await SENDERS[channel]({ kind: "system", title: "Scaper test alert", body: "If you can read this, alerts on this channel work.", url: null });
}
