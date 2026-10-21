import { handler, idParam, notFound } from "@/server/api";
import { getRun } from "@/server/repo/scrapes";
import { toCsv } from "@/lib/csv";

export const GET = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const run = getRun(idParam.parse((await params).id));
  if (!run?.result) throw notFound("Run");
  const idx = Math.max(0, Number(req.nextUrl.searchParams.get("dataset") ?? 0) || 0);
  const ds = run.result.datasets[idx];
  if (!ds) throw notFound("Dataset");
  const format = req.nextUrl.searchParams.get("format") === "json" ? "json" : "csv";
  const base = `${new URL(run.url).hostname}-${ds.name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const body = format === "json" ? JSON.stringify(ds.rows, null, 2) : "﻿" + toCsv(ds.columns, ds.rows);
  return new Response(body, {
    headers: {
      "content-type": format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${base}.${format}"`,
    },
  });
});
