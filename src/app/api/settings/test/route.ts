import { z } from "zod";
import { handler, HttpError, rateLimit, readJson } from "@/server/api";
import { chat } from "@/server/ai/client";
import { testChannel } from "@/server/notify";

const schema = z.object({ channel: z.enum(["ai", "ai_fast", "webhook", "telegram", "discord", "slack", "ntfy", "email"]) });

const SENT: Record<string, string> = {
  webhook: "Webhook accepted the test message.", telegram: "Telegram message sent.", discord: "Discord message sent.",
  slack: "Slack message sent.", ntfy: "ntfy push sent.", email: "Test email sent.",
};

/** Sends a real test request through a configured channel, so the user knows it works. */
export const POST = handler(async (req) => {
  rateLimit("settings:test", 10);
  const { channel } = await readJson(req, schema);
  if (channel !== "ai" && channel !== "ai_fast") {
    try {
      await testChannel(channel);
    } catch (e) {
      // Missing settings and refusals from the channel's server are the user's to fix, not a crash.
      const message = (e as Error).message || "The test message was not accepted.";
      throw new HttpError(/Settings →/.test(message) ? 400 : 502, "channel_failed", message);
    }
    return { ok: true, message: SENT[channel] };
  }
  const started = Date.now();
  const res = await chat([{ role: "user", content: "Reply with the single word: ready" }], { model: channel === "ai_fast" ? "fast" : "main", maxTokens: 10, temperature: 0 });
  return { ok: true, message: `${res.model} answered "${res.content.trim().slice(0, 40)}" in ${((Date.now() - started) / 1000).toFixed(1)}s.` };
});
