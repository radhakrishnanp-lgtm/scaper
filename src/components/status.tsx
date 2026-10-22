import { CheckCircle2, CircleDashed, CircleSlash, Clock, Loader2, ShieldAlert, XCircle } from "lucide-react";
import type { Job } from "@/server/repo/jobs";
import { Badge } from "./ui";

/** Watcher state: paused, waiting for its first check, ok, blocked or failing. */
export function StatusBadge({ status, enabled = true, failCount = 0 }: { status: string | null; enabled?: boolean; failCount?: number }) {
  if (!enabled) return <Badge><CircleSlash className="size-3" />paused</Badge>;
  if (!status) return <Badge tone="accent"><Clock className="size-3" />waiting</Badge>;
  if (status === "ok") return <Badge tone="success"><CheckCircle2 className="size-3" />ok</Badge>;
  if (status === "blocked") return <Badge tone="warning"><ShieldAlert className="size-3" />blocked</Badge>;
  return <Badge tone={failCount >= 3 ? "danger" : "warning"}><XCircle className="size-3" />error{failCount > 1 ? ` ×${failCount}` : ""}</Badge>;
}

const JOB: Record<string, { tone: "neutral" | "accent" | "success" | "warning" | "danger"; label: string; icon: React.ReactNode }> = {
  queued: { tone: "neutral", label: "queued", icon: <Clock className="size-3" /> },
  running: { tone: "accent", label: "running", icon: <Loader2 className="size-3 animate-spin" /> },
  succeeded: { tone: "success", label: "done", icon: <CheckCircle2 className="size-3" /> },
  failed: { tone: "danger", label: "failed", icon: <XCircle className="size-3" /> },
  cancelled: { tone: "neutral", label: "cancelled", icon: <CircleSlash className="size-3" /> },
};

export function JobStatusBadge({ status }: { status: string }) {
  const s = JOB[status] ?? { tone: "neutral" as const, label: status, icon: <CircleDashed className="size-3" /> };
  return <Badge tone={s.tone}>{s.icon}{s.label}</Badge>;
}

const RUN: Record<string, { tone: "neutral" | "accent" | "success" | "warning" | "danger"; label: string }> = {
  ok: { tone: "success", label: "ok" },
  partial: { tone: "warning", label: "partial" },
  error: { tone: "danger", label: "error" },
  blocked: { tone: "warning", label: "blocked" },
  cancelled: { tone: "neutral", label: "cancelled" },
};

export function RunStatusBadge({ status }: { status: string | null }) {
  if (!status) return <Badge>never run</Badge>;
  const s = RUN[status] ?? { tone: "neutral" as const, label: status };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export const JOB_KIND_LABEL: Record<string, string> = {
  task: "Task", scrape: "Scrape", watch: "Watcher check", product: "Price check", deal_search: "Deal search", backup: "Backup", bulk_products: "Bulk add", heal: "AI repair", sheets: "Sheets sync",
};

/** Where a finished job's output lives in the app. */
export function jobResultHref(j: Job): string | null {
  const r = j.result ?? {};
  if ((j.kind === "task" || j.kind === "scrape") && typeof r.runId === "string") return `/history/${r.runId}`;
  if (j.kind === "watch" && j.ref_id) return `/watchers/${j.ref_id}`;
  if (j.kind === "product" && j.ref_id) return `/deals/${j.ref_id}`;
  if (j.kind === "deal_search") return "/deals?tab=searches";
  if (j.kind === "bulk_products") return "/deals";
  if (j.kind === "backup") return "/settings?tab=data";
  if (j.kind === "heal" && j.ref_id) return `/tasks/${j.ref_id}?view=repairs`;
  if (j.kind === "sheets") return "/integrations?tab=deliveries";
  return null;
}
