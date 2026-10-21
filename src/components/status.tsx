import { Badge } from "./ui";

export function StatusBadge({ status, enabled = true, failCount = 0 }: { status: string | null; enabled?: boolean; failCount?: number }) {
  if (!enabled) return <Badge>paused</Badge>;
  if (!status) return <Badge tone="accent">waiting</Badge>;
  if (status === "ok") return <Badge tone="success">ok</Badge>;
  if (status === "blocked") return <Badge tone="warning">blocked</Badge>;
  return <Badge tone={failCount >= 3 ? "danger" : "warning"}>error</Badge>;
}
