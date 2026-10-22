import { handler, idParam } from "@/server/api";
import { forgetSeen } from "@/server/repo/scrapes";

/** Incremental tasks: forget what earlier runs saw, so the next run scrapes everything again. */
export const DELETE = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => ({ removed: forgetSeen(idParam.parse((await params).id)) }));
