import { Activity, Braces, Camera, FileText, IndianRupee, Map as MapIcon, Rss, SquareDashedMousePointer } from "lucide-react";
import type { Watcher } from "@/server/repo/watchers";
import type { Condition, WatchTarget } from "@/lib/schemas";

export type WatcherView = Watcher;
type TargetType = WatchTarget["type"];
type ConditionType = Condition["type"];

export const TARGETS: { type: TargetType; label: string; description: string; icon: React.ReactNode; conditions: ConditionType[]; forcedMode?: "fast" | "browser" }[] = [
  { type: "page", label: "Whole page", description: "All visible text", icon: <FileText className="size-5" />, conditions: ["any_change", "contains", "not_contains", "regex", "ai"] },
  { type: "selector", label: "Part of a page", description: "One element you pick", icon: <SquareDashedMousePointer className="size-5" />, conditions: ["any_change", "contains", "not_contains", "regex", "below", "above", "drop_percent", "rise_percent", "ai"] },
  { type: "price", label: "Price & stock", description: "Product price, auto-detected", icon: <IndianRupee className="size-5" />, conditions: ["any_change", "below", "above", "drop_percent", "rise_percent", "in_stock", "contains", "not_contains"] },
  { type: "visual", label: "Visual", description: "Screenshot pixel diff", icon: <Camera className="size-5" />, conditions: ["any_change"], forcedMode: "browser" },
  { type: "json", label: "JSON API", description: "A value in an API response", icon: <Braces className="size-5" />, conditions: ["any_change", "contains", "not_contains", "regex", "below", "above", "drop_percent", "rise_percent", "ai"], forcedMode: "fast" },
  { type: "feed", label: "RSS / Atom feed", description: "New posts", icon: <Rss className="size-5" />, conditions: ["any_change", "contains", "not_contains", "regex", "ai"], forcedMode: "fast" },
  { type: "sitemap", label: "Sitemap", description: "New pages on a site", icon: <MapIcon className="size-5" />, conditions: ["any_change", "contains", "regex"], forcedMode: "fast" },
  { type: "status", label: "Uptime", description: "Down, slow or back up", icon: <Activity className="size-5" />, conditions: ["any_change", "contains", "above"], forcedMode: "fast" },
];

export const targetInfo = (t: TargetType) => TARGETS.find((x) => x.type === t) ?? TARGETS[0]!;

export const CONDITION_LABEL: Record<ConditionType, string> = {
  any_change: "Anything changes",
  contains: "Text appears",
  not_contains: "Text disappears",
  regex: "Matches a pattern",
  below: "Value goes below",
  above: "Value goes above",
  drop_percent: "Value drops by %",
  rise_percent: "Value rises by %",
  in_stock: "Back in stock",
  ai: "AI decides it matters",
};

export function blankCondition(type: ConditionType): Condition {
  switch (type) {
    case "contains": case "not_contains": return { type, text: "", scope: "all" };
    case "regex": return { type, pattern: "", scope: "all" };
    case "below": case "above": return { type, value: 0 };
    case "drop_percent": case "rise_percent": return { type, percent: 10 };
    case "ai": return { type, question: "" };
    default: return { type } as Condition;
  }
}

const scopeText = (s?: string) => (s === "added" ? " in added lines" : s === "removed" ? " in removed lines" : "");

export function conditionText(c: Condition, target?: TargetType): string {
  switch (c.type) {
    case "any_change": return target === "status" ? "Status changes" : target === "visual" ? "Looks different" : "Any change";
    case "contains": return target === "status" && /down/i.test(c.text) ? "Goes down" : `“${c.text}” appears${scopeText(c.scope)}`;
    case "not_contains": return `“${c.text}” disappears${scopeText(c.scope)}`;
    case "regex": return `Matches /${c.pattern}/${scopeText(c.scope)}`;
    case "below": return `Below ${c.value.toLocaleString("en-IN")}`;
    case "above": return target === "status" ? `Slower than ${c.value} ms` : `Above ${c.value.toLocaleString("en-IN")}`;
    case "drop_percent": return `Drops ${c.percent}%+`;
    case "rise_percent": return `Rises ${c.percent}%+`;
    case "in_stock": return "Back in stock";
    case "ai": return "AI decides";
  }
}

export function rulesText(w: Pick<Watcher, "condition" | "options" | "target">) {
  const all = [w.condition, ...w.options.moreConditions].map((c) => conditionText(c, w.target.type));
  return all.join(w.options.match === "any" ? " or " : " and ");
}

export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
