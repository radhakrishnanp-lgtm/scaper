import { z } from "zod";
import { handler, readJson } from "@/server/api";
import { audit } from "@/server/repo/events";
import { createWatcher, listWatchers } from "@/server/repo/watchers";
import { parseUrlList } from "@/server/tasks/urls";
import { notifySchema, tagsSchema, watcherSchema } from "@/lib/schemas";

const schema = z.object({
  urls: z.string().min(1).max(200_000),
  intervalMinutes: z.number().int().min(1).max(10080).default(60),
  mode: z.enum(["browser", "fast"]).default("fast"),
  tags: tagsSchema,
  notify: notifySchema.default(notifySchema.parse({})),
});

/** Paste a list of URLs: each becomes a "whole page, any change" watcher. Existing URLs are skipped. */
export const POST = handler(async (req) => {
  const input = await readJson(req, schema);
  const urls = parseUrlList([input.urls]).slice(0, 500);
  const existing = new Set(listWatchers().map((w) => w.url));
  let added = 0;
  const errors: string[] = [];
  for (const url of urls) {
    if (existing.has(url)) continue;
    const u = new URL(url);
    const parsed = watcherSchema.safeParse({
      name: `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 120), url, mode: input.mode,
      target: { type: "page" }, condition: { type: "any_change" }, notify: input.notify, intervalMinutes: input.intervalMinutes, tags: input.tags,
    });
    if (!parsed.success) { errors.push(`${url}: ${parsed.error.issues[0]?.message}`); continue; }
    createWatcher(parsed.data);
    existing.add(url);
    added++;
  }
  audit("watchers.imported", { added });
  return { added, skipped: urls.length - added - errors.length, errors: errors.slice(0, 20) };
});
