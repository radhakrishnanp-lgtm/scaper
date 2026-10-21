import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/api";
import { chat } from "@/server/ai/client";
import { sendTelegram, sendWebhook } from "@/server/notify";

const schema = z.object({ channel: z.enum(["ai", "ai_fast", "webhook", "telegram"]) });

/** Sends a real test request through a configured channel, so the user knows it works. */
export const POST = handler(async (req) => {
  rateLimit("settings:test", 10);
  const { channel } = await readJson(req, schema);
  const alert = { kind: "system" as const, title: "Scaper test", body: "If you can read this, notifications from Scaper work." };
  if (channel === "webhook") { await sendWebhook(alert); return { ok: true, message: "Webhook accepted the test message." }; }
  if (channel === "telegram") { await sendTelegram(alert); return { ok: true, message: "Telegram message sent." }; }
  const started = Date.now();
  const res = await chat([{ role: "user", content: "Reply with the single word: ready" }], { model: channel === "ai_fast" ? "fast" : "main", maxTokens: 10, temperature: 0 });
  return { ok: true, message: `${res.model} answered "${res.content.trim().slice(0, 40)}" in ${((Date.now() - started) / 1000).toFixed(1)}s.` };
});
