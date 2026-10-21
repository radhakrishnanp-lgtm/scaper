import { Badge } from "./ui";

export type DealStats = {
  current: number | null; low: number | null; high: number | null; avg30: number | null; points: number; daysTracked: number;
  claimedDiscount: number | null; realDiscount: number | null; isLowest: boolean; inflatedMrp: boolean; score: number | null;
  verdict: "great" | "good" | "fair" | "wait" | "collecting"; summary: string;
};

export type ProductView = {
  id: string; url: string; source: string; title: string | null; image: string | null; currency: string | null;
  current_price: number | null; list_price: number | null; rating: number | null; review_count: number | null; in_stock: boolean | null;
  target_price: number | null; interval_minutes: number; enabled: boolean; last_checked_at: string | null; next_check_at: string | null;
  last_error: string | null; created_at: string; stats: DealStats;
};

const VERDICT: Record<DealStats["verdict"], { tone: "success" | "accent" | "neutral" | "warning"; label: string }> = {
  great: { tone: "success", label: "Great deal" },
  good: { tone: "accent", label: "Good price" },
  fair: { tone: "neutral", label: "Fair" },
  wait: { tone: "warning", label: "Wait" },
  collecting: { tone: "neutral", label: "Collecting history" },
};

export function VerdictBadge({ stats }: { stats: DealStats }) {
  const v = VERDICT[stats.verdict];
  return <Badge tone={v.tone}>{v.label}{stats.score !== null && stats.verdict !== "collecting" ? ` · ${stats.score}` : ""}</Badge>;
}

export function ScoreBar({ score }: { score: number | null }) {
  if (score === null) return null;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} aria-label="Deal score">
      <div className="h-full rounded-full bg-accent" style={{ width: `${score}%` }} />
    </div>
  );
}
