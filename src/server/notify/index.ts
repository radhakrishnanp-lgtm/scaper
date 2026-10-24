import "server-only";
import nodemailer from "nodemailer";
import { fetch as undiciFetch } from "undici";
import { EXTERNAL_CHANNELS, type AlertEvent, type NotifyChannels, type Settings } from "@/lib/schemas";
import { bus } from "../bus";
import { db } from "../db";
import { newId, now } from "../repo/util";
import { dispatcherFor } from "../fetcher/http";
import { audit } from "../repo/events";
import { addNotification } from "../repo/notifications";
import { getSettings } from "../repo/settings";
import { emitWebhook, type WebhookEvent } from "../integrations/webhooks";

export type Alert = {
  kind: "watcher" | "price" | "agent" | "system" | "task" | "deal" | "briefing" | "bot";
  /** Which "where each alert goes" rule applies (Settings → Alerts). */
  event?: AlertEvent;
  /** The bot that sent it, so bots never wake each other in a loop. */
  botId?: string | null;
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

const ALERT_EVENT: Record<Alert["kind"], WebhookEvent> = {
  watcher: "watcher.change", price: "price", deal: "price", task: "task.health", agent: "alert", system: "alert", briefing: "alert", bot: "alert",
};

/**
 * Alerts go to every webhook endpoint subscribed to their event, signed (HMAC-SHA256 in x-scaper-signature),
 * logged in Integrations → Webhooks and retried on failure.
 */
export async function sendWebhook(alert: Alert) {
  const data = alert.data ?? {};
  await emitWebhook(ALERT_EVENT[alert.kind], {
    kind: alert.kind, title: alert.title, body: alert.body, url: alert.url ?? null, data,
    ...(alert.kind === "watcher" ? { important: data.important ?? null, summary: data.summary ?? null } : {}),
  }, { refId: alert.watcherId ?? alert.productId ?? (typeof data.recipeId === "string" ? data.recipeId : null), strict: true, name: `scaper.${alert.kind}` });
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

/** WhatsApp params may not hold newlines, tabs or more than four spaces in a row. */
const waParam = (s: string) => s.replace(/[\r\n\t]+/g, " · ").replace(/ {4,}/g, "   ").trim().slice(0, 1000);

/**
 * WhatsApp through Meta's Cloud API (your WhatsApp Business number), or CallMeBot (free, only to your own number).
 * WhatsApp only lets a business send free text within 24 hours of your last message to it; outside that window
 * the Cloud API needs an approved template with one {{1}} variable, which gets the alert text.
 */
export async function sendWhatsapp(alert: Alert) {
  const n = getSettings().notifications;
  const text = `*${alert.title}*\n${alert.body.slice(0, 3000)}${alert.url ? `\n${alert.url}` : ""}`;
  if (n.whatsappProvider === "callmebot") {
    if (!n.callmebotKey || !n.whatsappTo) throw new Error("Add your WhatsApp number and CallMeBot API key in Settings → Alerts.");
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(n.whatsappTo)}&text=${encodeURIComponent(text.slice(0, 1500))}&apikey=${encodeURIComponent(n.callmebotKey)}`;
    const res = await undiciFetch(url, { dispatcher: dispatcherFor(""), signal: AbortSignal.timeout(15_000) });
    const body = await res.text();
    if (!res.ok || /error|not valid|invalid/i.test(body.slice(0, 400))) throw new Error(`CallMeBot: ${body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || `HTTP ${res.status}`}`);
    return;
  }
  if (!n.whatsappToken || !n.whatsappPhoneId || !n.whatsappTo) throw new Error("Add a WhatsApp Cloud API token, phone number ID and your number in Settings → Alerts.");
  const to = n.whatsappTo.replace(/[^\d]/g, "");
  const message = n.whatsappTemplate
    ? { type: "template", template: { name: n.whatsappTemplate, language: { code: n.whatsappTemplateLang || "en" }, components: [{ type: "body", parameters: [{ type: "text", text: waParam(`${alert.title}: ${alert.body}`) }] }] } }
    : { type: "text", text: { preview_url: false, body: text.slice(0, 4000) } };
  try {
    await post(`https://graph.facebook.com/v21.0/${encodeURIComponent(n.whatsappPhoneId)}/messages`, { messaging_product: "whatsapp", recipient_type: "individual", to, ...message }, { authorization: `Bearer ${n.whatsappToken}` });
  } catch (e) {
    const msg = (e as Error).message;
    // 131047: more than 24 hours since you last wrote to the business number.
    if (/131047|re-engagement|24 hours/i.test(msg)) throw new Error("WhatsApp only allows free text within 24 hours of your last message to the business number. Send it any message, or set an approved template in Settings → Alerts.");
    throw e;
  }
}

const SENDERS: Record<ExternalChannel, (a: Alert) => Promise<void>> = {
  webhook: sendWebhook, telegram: sendTelegram, discord: sendDiscord, slack: sendSlack, ntfy: sendNtfy, email: sendEmail, whatsapp: sendWhatsapp,
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
  const { notifications: n, integrations } = getSettings();
  return {
    desktop: true, webhook: Boolean(n.webhookUrl || integrations.webhooks.some((w) => w.enabled)), telegram: Boolean(n.telegramBotToken && n.telegramChatId), discord: Boolean(n.discordWebhookUrl),
    slack: Boolean(n.slackWebhookUrl), ntfy: Boolean(n.ntfyUrl), email: Boolean(n.smtpHost && n.emailTo),
    whatsapp: n.whatsappProvider === "callmebot" ? Boolean(n.callmebotKey && n.whatsappTo) : Boolean(n.whatsappToken && n.whatsappPhoneId && n.whatsappTo),
  };
}

/** The channels for one alert: the item's own picks plus Settings → Alerts → "where each alert goes". */
export function routeChannels(event: AlertEvent | undefined, base: Partial<NotifyChannels>): Partial<NotifyChannels> {
  if (!event) return base;
  const route = getSettings().notifications.routes[event] ?? [];
  if (!route.length) return base;
  const ready = configuredChannels();
  const out = { ...base };
  for (const r of route) {
    if (r === "all") { for (const c of EXTERNAL_CHANNELS) if (ready[c]) out[c] = true; }
    else out[r] = true;
  }
  return out;
}

/**
 * Delivers an alert: always to the in-app inbox (and the live stream, which
 * shows a desktop notification while Scaper is open), plus any external channels.
 * A failing channel never blocks the others.
 */
export async function deliver(alert: Alert, picked: Partial<NotifyChannels>) {
  const settings = getSettings().notifications;
  const quiet = inQuietHours(settings);
  const channels = routeChannels(alert.event, picked);
  const n = addNotification(alert);
  const refId = alert.watcherId ?? alert.productId ?? (typeof alert.data?.recipeId === "string" ? alert.data.recipeId : typeof alert.data?.dealSearchId === "string" ? alert.data.dealSearchId : null);
  bus.emit({ type: "notification", id: n.id, title: n.title, body: n.body, url: n.url, desktop: Boolean(channels.desktop) && !quiet && !settings.muteAll, kind: alert.kind, event: alert.event ?? null, refId, botId: alert.botId ?? null });
  if (settings.muteAll) {
    audit("notify.muted", { kind: alert.kind, title: alert.title });
    return n;
  }
  if (quiet) {
    // Held, not dropped: sent when quiet hours end (screenshots are left out).
    const rest = { ...alert, image: null };
    if ((Object.keys(SENDERS) as ExternalChannel[]).some((c) => channels[c])) {
      db().prepare("INSERT INTO held_alerts (id, alert, channels, created_at) VALUES (?, ?, ?, ?)").run(newId(), JSON.stringify(rest), JSON.stringify(channels), now());
    }
    audit("notify.quiet_hours", { kind: alert.kind, title: alert.title });
    return n;
  }
  await send(alert, channels);
  return n;
}

async function send(alert: Alert, channels: Partial<NotifyChannels>) {
  const tasks = (Object.keys(SENDERS) as ExternalChannel[]).filter((c) => channels[c]).map((c) => [c, () => SENDERS[c](alert)] as const);
  const results = await Promise.allSettled(tasks.map(([, fn]) => fn()));
  results.forEach((r, i) => {
    const channel = tasks[i]![0];
    if (r.status === "rejected") audit("notify.failed", { channel, error: (r.reason as Error).message }, "warn");
    else audit("notify.sent", { channel, kind: alert.kind });
  });
}

const HELD_ONE_BY_ONE = 5;

/**
 * After quiet hours: up to 5 held alerts go out as they were; more than that become one summary per set
 * of channels, so the morning does not start with a flood. Returns how many held alerts were handled.
 */
export async function flushHeldAlerts() {
  const n = getSettings().notifications;
  if (n.muteAll || inQuietHours(n)) return 0;
  const rows = db().prepare("SELECT * FROM held_alerts ORDER BY created_at").all() as { id: string; alert: string; channels: string; created_at: string }[];
  if (!rows.length) return 0;
  db().prepare(`DELETE FROM held_alerts WHERE id IN (${rows.map(() => "?").join(",")})`).run(...rows.map((r) => r.id));
  const held = rows.map((r) => ({ alert: JSON.parse(r.alert) as Alert, channels: JSON.parse(r.channels) as Partial<NotifyChannels>, at: r.created_at }));
  if (held.length <= HELD_ONE_BY_ONE) {
    for (const h of held) await send({ ...h.alert, title: `${h.alert.title} (held during quiet hours)` }, h.channels);
  } else {
    const groups = new Map<string, typeof held>();
    for (const h of held) {
      const key = JSON.stringify(EXTERNAL_CHANNELS.filter((c) => h.channels[c]));
      groups.set(key, [...(groups.get(key) ?? []), h]);
    }
    for (const [key, list] of groups) {
      const channels = Object.fromEntries((JSON.parse(key) as string[]).map((c) => [c, true])) as Partial<NotifyChannels>;
      const lines = list.slice(0, 25).map((h) => `• ${h.at.slice(11, 16)} ${h.alert.title}`);
      await send({ kind: "system", title: `${list.length} alerts during quiet hours`, body: `${lines.join("\n")}${list.length > 25 ? `\n…and ${list.length - 25} more in the inbox.` : ""}` }, channels);
    }
  }
  audit("notify.held_sent", { count: held.length });
  return held.length;
}

/** Settings → "Send test" for one channel. */
export async function testChannel(channel: ExternalChannel) {
  await SENDERS[channel]({ kind: "system", title: "Scaper test alert", body: "If you can read this, alerts on this channel work.", url: null });
}
