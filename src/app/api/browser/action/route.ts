import { handler, readJson } from "@/server/api";
import { action } from "@/server/live-browser/session";
import { browserActionSchema } from "@/lib/schemas";

/** Navigate, back, forward, reload, stop, new/close/switch tab, resize the view, answer a page dialog. */
export const POST = handler(async (req) => ({ state: await action(await readJson(req, browserActionSchema)) }));
