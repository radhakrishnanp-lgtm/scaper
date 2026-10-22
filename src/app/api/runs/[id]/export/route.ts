import { handler, idParam, notFound } from "@/server/api";
import { serializeDataset, type ExportFormat } from "@/server/export/formats";
import { getRun } from "@/server/repo/scrapes";

const FORMATS: ExportFormat[] = ["csv", "json", "ndjson", "xlsx"];

export const GET = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const run = getRun(idParam.parse((await params).id));
  if (!run?.result) throw notFound("Run");
  const idx = Math.max(0, Number(req.nextUrl.searchParams.get("dataset") ?? 0) || 0);
  const ds = run.result.datasets[idx];
  if (!ds) throw notFound("Dataset");
  const requested = req.nextUrl.searchParams.get("format") as ExportFormat | null;
  const format: ExportFormat = requested && FORMATS.includes(requested) ? requested : "csv";
  const base = `${new URL(run.url).hostname}-${ds.name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const out = serializeDataset(ds, format);
  return new Response(typeof out.body === "string" ? out.body : Buffer.from(out.body), {
    headers: { "content-type": out.type, "content-disposition": `attachment; filename="${base}.${out.ext}"` },
  });
});
