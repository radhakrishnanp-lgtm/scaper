import { handler } from "@/server/api";
import { fleetHealth } from "@/server/ops/health";

export const dynamic = "force-dynamic";

/** Operations overview: health of every task and watcher, failures grouped by cause, repairs and changes to review. */
export const GET = handler(async () => fleetHealth());
