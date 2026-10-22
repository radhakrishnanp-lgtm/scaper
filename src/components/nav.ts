import {
  Activity, Bell, Bot, Database, Globe, LayoutDashboard, ListChecks, Radar, ScanSearch, ScrollText, Settings, Tag,
  type LucideIcon,
} from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon; keywords?: string; match?: (path: string) => boolean };
export type NavGroup = { label: string; items: NavItem[] };

/** The app's sections, grouped the way people use them: collect data, keep an eye on things, run the system. */
export const NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [{ href: "/", label: "Dashboard", icon: LayoutDashboard, keywords: "home overview stats", match: (p) => p === "/" }],
  },
  {
    label: "Collect",
    items: [
      { href: "/scrape", label: "Quick scrape", icon: ScanSearch, keywords: "scrape extract page url selectors" },
      { href: "/tasks", label: "Tasks", icon: ListChecks, keywords: "recipes saved scrapers crawl pagination schedule" },
      { href: "/runs", label: "Runs", icon: Activity, keywords: "jobs queue running logs" },
      { href: "/history", label: "Data", icon: Database, keywords: "history results datasets export csv excel" },
    ],
  },
  {
    label: "Monitor",
    items: [
      { href: "/watchers", label: "Watchers", icon: Radar, keywords: "website change monitor diff visual uptime feed" },
      { href: "/deals", label: "Prices & deals", icon: Tag, keywords: "amazon price tracker keepa deals products" },
      { href: "/notifications", label: "Alerts", icon: Bell, keywords: "notifications inbox" },
    ],
  },
  {
    label: "Assist",
    items: [{ href: "/agent", label: "AI agent", icon: Bot, keywords: "ai chat assistant llm" }],
  },
  {
    label: "System",
    items: [
      { href: "/sites", label: "Sites", icon: Globe, keywords: "hosts rules cookies headers delay backoff" },
      { href: "/logs", label: "Logs", icon: ScrollText, keywords: "events audit errors" },
      { href: "/settings", label: "Settings", icon: Settings, keywords: "ai keys channels telegram email backups tokens" },
    ],
  },
];

export const ALL_NAV = NAV.flatMap((g) => g.items);

export function isActive(item: NavItem, path: string) {
  return item.match ? item.match(path) : path === item.href || path.startsWith(`${item.href}/`);
}
