import { useState } from "react";
import { Tag } from "lucide-react";
import type { DealStats } from "@/server/deals/score";
import type { Product } from "@/server/repo/products";
import type { ListingItem } from "@/server/deals/parsers";
import { Badge } from "./ui";

export type { DealStats };
export type ProductView = Product & { stats: DealStats };
export type ScanItem = ListingItem & { tracked: boolean; stats: DealStats | null; aiNote?: string };

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

export function Thumb({ src, alt, size = "md" }: { src: string | null; alt: string; size?: "md" | "lg" }) {
  const box = size === "lg" ? "size-40" : "size-16";
  const [failed, setFailed] = useState<string | null>(null);
  return src && failed !== src
    // eslint-disable-next-line @next/next/no-img-element -- product images come from many store CDNs
    ? <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(src)} className={`${box} shrink-0 overflow-hidden rounded-lg border border-border bg-white object-contain p-1 text-[0px]`} />
    : <div className={`${box} flex shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted`} role="img" aria-label={alt}><Tag className="size-5" /></div>;
}

export const atTarget = (p: ProductView) => p.target_price !== null && p.current_price !== null && p.current_price <= p.target_price;
