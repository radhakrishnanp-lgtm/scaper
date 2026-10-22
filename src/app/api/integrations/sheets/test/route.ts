import { z } from "zod";
import { handler, HttpError, rateLimit, readJson } from "@/server/api";
import { testSheet } from "@/server/integrations/sheets";

/** Signs in with the service account and reads the spreadsheet's name and tabs. */
export const POST = handler(async (req) => {
  rateLimit("sheets:test", 20, 5);
  const { spreadsheet } = await readJson(req, z.object({ spreadsheet: z.string().trim().min(1, "Paste the sheet's link").max(300) }));
  try {
    const r = await testSheet(spreadsheet);
    return { ...r, message: `Connected to “${r.title}” (${r.sheets.length} tab${r.sheets.length === 1 ? "" : "s"}).` };
  } catch (e) {
    throw new HttpError(400, "sheets_failed", (e as Error).message);
  }
});
