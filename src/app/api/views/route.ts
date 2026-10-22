import { z } from "zod";
import { handler, readJson } from "@/server/api";
import { listViews, saveView } from "@/server/repo/views";

const scope = z.string().trim().min(1).max(120).regex(/^[\w:.-]+$/);

export const GET = handler(async (req) => ({ items: listViews(scope.parse(req.nextUrl.searchParams.get("scope") ?? "")) }));

const body = z.object({ id: z.string().uuid().optional(), scope, name: z.string().trim().min(1, "Name the view").max(60), state: z.record(z.string(), z.unknown()) });

/** Saves a table view (columns, widths, pinning, filters, sort). */
export const POST = handler(async (req) => {
  const b = await readJson(req, body);
  if (JSON.stringify(b.state).length > 20_000) throw new Error("This view is too large to save.");
  return { view: saveView(b) };
});
