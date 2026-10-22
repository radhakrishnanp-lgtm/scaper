"use client";

import Link from "next/link";
import {
  Activity, AlertTriangle, ArrowRight, Bell, Bot, CheckCircle2, Circle, Database, ListChecks, Plus, Radar, ScanSearch, Tag, Terminal, Timer,
} from "lucide-react";
import type { Job } from "@/server/repo/jobs";
import { BarChart } from "@/components/charts";
import { useLive } from "@/components/live";
import { JobStatusBadge, JOB_KIND_LABEL, StatusBadge } from "@/components/status";
import { Badge, Button, Callout, Card, CardHeader, Code, EmptyState, ErrorNote, PageHeader, Progress, Skeleton, Stat } from "@/components/ui";
import { hostOf, lastDays, shortDay, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type Stats = {
  watchers: number; activeWatchers: number; failingWatchers: number; products: number; recipes: number; scheduledTasks: number; dealSearches: number;
  changes24h: number; scrapes24h: number; rows24h: number; priceDrops24h: number; successRate7d: number | null; unread: number;
  recentAlerts: { id: string; title: string; body: string; created_at: string; read_at: string | null; kind: string; watcher_id: string | null }[];
  upcoming: { id: string; name: string; url: string; next_check_at: string | null; last_status: string | null }[];
  jobs: Record<string, number>;
  activeJobs: Job[];
  charts: {
    jobs: { day: string; ok: number; failed: number; total: number }[];
    changes: { day: string; c: number }[];
    rows: { day: string; c: number }[];
    alerts: { day: string; kind: string; c: number }[];
  };
  ai: { configured: boolean; usage: { requests: number; tokens: number } };
  browser: boolean;
  scheduler: { running: boolean; activeJobs: number; lastTick: string | null };
};

function Step({ done, title, children, href, cta }: { done: boolean; title: string; children: React.ReactNode; href?: string; cta?: string }) {
  return (
    <li className="flex gap-3 py-3">
      {done ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-label="Done" /> : <Circle className="mt-0.5 size-5 shrink-0 text-muted" aria-label="Not done" />}
      <div className="min-w-0 flex-1">
        <p className={done ? "text-sm font-medium text-muted line-through" : "text-sm font-medium"}>{title}</p>
        {!done && <div className="mt-0.5 text-sm text-muted">{children}</div>}
      </div>
      {!done && href && <Link prefetch={false} href={href} className="shrink-0 self-center text-sm font-medium text-accent hover:underline">{cta}</Link>}
    </li>
  );
}

const byDay = <T extends { day: string },>(rows: T[], days: string[], pick: (r: T[]) => Record<string, number>) =>
  days.map((d) => ({ label: shortDay(d), values: pick(rows.filter((r) => r.day === d)) }));

export default function Dashboard() {
  const { data, error, loading, reload } = useApi<Stats>("/api/stats", { pollMs: 30_000 });
  const live = useLive();
  if (error) return <ErrorNote message={error} onRetry={reload} />;

  const days = lastDays(14);
  const onboarding = data && (!data.browser || data.scrapes24h + data.recipes === 0 || data.watchers === 0 || !data.ai.configured);
  const active = live.active.length ? live.active : data?.activeJobs ?? [];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Everything Scaper collects and watches, at a glance."
        actions={<>
          <Link prefetch={false} href="/scrape"><Button variant="secondary" icon={<ScanSearch className="size-4" />}>Quick scrape</Button></Link>
          <Link prefetch={false} href="/watchers/new"><Button variant="secondary" icon={<Radar className="size-4" />}>New watcher</Button></Link>
          <Link prefetch={false} href="/tasks/new"><Button icon={<Plus className="size-4" />}>New task</Button></Link>
        </>}
      />

      {loading || !data ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : (
        <div className="space-y-6">
          {(data.failingWatchers > 0 || !data.browser) && (
            <div className="space-y-2">
              {data.failingWatchers > 0 && (
                <Callout tone="warning" icon={<AlertTriangle className="size-4 text-warning" />} title={`${data.failingWatchers} watcher${data.failingWatchers === 1 ? " is" : "s are"} failing`}
                  action={<Link prefetch={false} href="/watchers?status=errors" className="shrink-0 text-sm font-medium text-accent hover:underline">Review</Link>}>
                  Usually a selector stopped matching after a site redesign, or the site is blocking automated checks.
                </Callout>
              )}
              {!data.browser && (
                <Callout tone="neutral" icon={<Terminal className="size-4" />} title="Browser mode is not installed">
                  Run <Code>npm run setup:browser</Code> once. Fast mode works without it.
                </Callout>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Watchers" value={data.activeWatchers} hint={data.failingWatchers ? <span className="text-warning">{data.failingWatchers} failing</span> : `${data.watchers} total`} icon={<Radar className="size-4" />} />
            <Stat label="Changes · 24h" value={data.changes24h} hint={`${data.unread} unread alert${data.unread === 1 ? "" : "s"}`} icon={<Bell className="size-4" />} />
            <Stat label="Rows · 24h" value={data.rows24h.toLocaleString("en-IN")} hint={`${data.scrapes24h} run${data.scrapes24h === 1 ? "" : "s"}`} icon={<Database className="size-4" />} />
            <Stat label="Tasks" value={data.recipes} hint={`${data.scheduledTasks} scheduled`} icon={<ListChecks className="size-4" />} />
            <Stat label="Products" value={data.products} hint={data.priceDrops24h ? <span className="text-success">{data.priceDrops24h} price alert{data.priceDrops24h === 1 ? "" : "s"} today</span> : `${data.dealSearches} saved deal search${data.dealSearches === 1 ? "" : "es"}`} icon={<Tag className="size-4" />} />
            <Stat label="Job success · 7d" value={data.successRate7d === null ? "—" : `${data.successRate7d}%`} hint={`${data.jobs.running ?? 0} running · ${data.jobs.queued ?? 0} queued`} icon={<Activity className="size-4" />} />
          </div>

          {onboarding && (
            <Card>
              <CardHeader title="Get set up" description="A few steps to get the most out of Scaper." />
              <ol className="divide-y divide-border px-5">
                <Step done={data.browser} title="Install the scraping browser">
                  Run <Code>npm run setup:browser</Code> once in the project folder. Fast mode works without it.
                </Step>
                <Step done={data.scrapes24h + data.recipes > 0} title="Scrape your first page" href="/scrape" cta="Open scraper">Paste any URL. Auto mode finds lists, tables, products and links for you.</Step>
                <Step done={data.watchers > 0} title="Watch a page for changes" href="/watchers/new" cta="Add watcher">Get an alert when a price drops, an item is back in stock, or a page changes.</Step>
                <Step done={data.ai.configured} title="Connect your AI model (optional)" href="/settings?tab=ai" cta="Settings">Any OpenAI-compatible API: OpenAI, OpenRouter, Groq, Ollama, LM Studio and more.</Step>
              </ol>
            </Card>
          )}

          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="p-5">
              <h2 className="mb-3 text-sm font-semibold">Jobs per day</h2>
              <BarChart
                label="Jobs per day, last 14 days"
                data={byDay(data.charts.jobs, days, (r) => ({ ok: r[0]?.ok ?? 0, failed: r[0]?.failed ?? 0, other: Math.max(0, (r[0]?.total ?? 0) - (r[0]?.ok ?? 0) - (r[0]?.failed ?? 0)) }))}
                series={[{ key: "ok", label: "Succeeded", color: "var(--accent)" }, { key: "failed", label: "Failed", color: "var(--danger)" }, { key: "other", label: "Other", color: "var(--border)" }]}
                emptyText="Jobs appear here as Scaper works."
              />
            </Card>
            <Card className="p-5">
              <h2 className="mb-3 text-sm font-semibold">Changes detected</h2>
              <BarChart label="Watcher changes per day" data={byDay(data.charts.changes, days, (r) => ({ c: r[0]?.c ?? 0 }))} series={[{ key: "c", label: "Changes", color: "var(--accent)" }]} emptyText="No changes in the last 14 days." />
            </Card>
            <Card className="p-5">
              <h2 className="mb-3 text-sm font-semibold">Rows scraped</h2>
              <BarChart label="Rows scraped per day" data={byDay(data.charts.rows, days, (r) => ({ c: r[0]?.c ?? 0 }))} series={[{ key: "c", label: "Rows", color: "var(--accent)" }]} emptyText="Run a scrape to see data here." />
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card>
              <CardHeader title="Running now" actions={<Link prefetch={false} href="/runs" className="text-sm font-medium text-accent hover:underline">All runs</Link>} />
              {active.length ? (
                <ul className="divide-y divide-border">
                  {active.slice(0, 6).map((j) => (
                    <li key={j.id} className="space-y-1.5 px-5 py-3">
                      <div className="flex items-center gap-2">
                        <Link prefetch={false} href={`/runs/${j.id}`} className="min-w-0 flex-1 truncate text-sm font-medium hover:text-accent">{j.title}</Link>
                        <JobStatusBadge status={j.status} />
                      </div>
                      {j.status === "running" && <Progress label={j.title} value={j.progress?.total ? j.progress.done ?? 0 : null} max={j.progress?.total ?? 100} />}
                      <p className="text-xs text-muted">{JOB_KIND_LABEL[j.kind] ?? j.kind} · {j.trigger} · {timeAgo(j.created_at)}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState icon={<Timer className="size-5" />} title="All quiet">Scheduled checks and tasks start on their own.</EmptyState>
              )}
            </Card>

            <Card>
              <CardHeader title="Recent alerts" actions={<Link prefetch={false} href="/notifications" className="text-sm font-medium text-accent hover:underline">All alerts</Link>} />
              {data.recentAlerts.length ? (
                <ul className="divide-y divide-border">
                  {data.recentAlerts.map((a) => (
                    <li key={a.id}>
                      <Link prefetch={false} href={a.watcher_id ? `/watchers/${a.watcher_id}` : "/notifications"} className="flex items-start gap-3 px-5 py-3 hover:bg-surface-2/50">
                        <span className={a.read_at ? "mt-1.5 size-2 shrink-0 rounded-full bg-border" : "mt-1.5 size-2 shrink-0 rounded-full bg-accent"} aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{a.title}</span>
                          <span className="block truncate text-xs text-muted">{a.body.split("\n")[0]}</span>
                        </span>
                        <span className="shrink-0 text-xs text-muted">{timeAgo(a.created_at)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState icon={<Bell className="size-5" />} title="No alerts yet">Alerts appear when a watcher sees a change or a price drops.</EmptyState>
              )}
            </Card>

            <Card>
              <CardHeader title="Next checks" actions={<Link prefetch={false} href="/watchers" className="text-sm font-medium text-accent hover:underline">Watchers</Link>} />
              {data.upcoming.length ? (
                <ul className="divide-y divide-border">
                  {data.upcoming.map((w) => (
                    <li key={w.id}>
                      <Link prefetch={false} href={`/watchers/${w.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2/50">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{w.name}</span>
                          <span className="block truncate text-xs text-muted">{hostOf(w.url)}</span>
                        </span>
                        <StatusBadge status={w.last_status} />
                        <span className="w-16 shrink-0 text-right text-xs text-muted">{timeAgo(w.next_check_at)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState icon={<Radar className="size-5" />} title="No watchers yet" action={<Link prefetch={false} href="/watchers/new"><Button size="sm">Add watcher</Button></Link>}>Watch prices, stock, news pages, feeds or uptime.</EmptyState>
              )}
            </Card>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5"><span className={data.scheduler.running ? "size-2 rounded-full bg-success" : "size-2 rounded-full bg-danger"} />Scheduler {data.scheduler.running ? `running · last tick ${timeAgo(data.scheduler.lastTick)}` : "stopped"}</span>
            <span className="inline-flex items-center gap-1.5"><Bot className="size-3.5" />AI {data.ai.configured ? `connected · ${data.ai.usage.requests} request${data.ai.usage.requests === 1 ? "" : "s"} today` : <Link prefetch={false} href="/settings?tab=ai" className="text-accent hover:underline">not set up</Link>}</span>
            <span>Browser mode {data.browser ? <Badge tone="success">ready</Badge> : <Badge tone="warning">not installed</Badge>}</span>
            <Link prefetch={false} href="/logs" className="inline-flex items-center gap-1 text-accent hover:underline">Logs <ArrowRight className="size-3" /></Link>
          </div>
        </div>
      )}
    </>
  );
}
