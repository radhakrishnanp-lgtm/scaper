import { handler, HttpError } from "@/server/api";
import { audit } from "@/server/repo/events";
import { exportConfig, importConfig } from "@/server/ops/config";

const MAX_IMPORT = 5 * 1024 * 1024;

/** Download your setup (tasks, watchers, products, deal searches, site rules) as JSON. */
export const GET = handler(async () => {
  const data = exportConfig();
  audit("config.exported", {});
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "content-type": "application/json", "content-disposition": `attachment; filename="scaper-config-${data.exportedAt.slice(0, 10)}.json"` },
  });
});

/** Import a file made by the export above. Adds new items; never overwrites existing ones. */
export const POST = handler(async (req) => {
  const text = await req.text();
  if (text.length > MAX_IMPORT) throw new HttpError(413, "too_large", "The file is larger than 5 MB.");
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new HttpError(400, "bad_json", "This is not a JSON file."); }
  return { report: importConfig(data) };
});
