"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, Bell, Bot, CheckCircle2, Circle, Radar, ScanSearch, Tag, Terminal } from "lucide-react";
import { Badge, Card, CardHeader, EmptyState, ErrorNote, LoadingRows, PageHeader, Skeleton, Stat } from "@/components/ui";
import { hostOf, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type Stats = {
  watchers: number; activeWatchers: number; failingWatchers: number; products: number; recipes: number;
  changes24h: number; scrapes24h: number; unread: number;
  recentAlerts: { id: string; title: string; body: string; created_at: string; read_at: string | null; kind: string }[];
  upcoming: { id: string; name: string; url: string; next_check_at: string | null; last_status: string | null }[];
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
      {!done && href && <Link href={href} className="shrink-0 self-center text-sm font-medium text-accent hover:underline">{cta}</Link>}
    </li>
  );
}

export default function Dashboard() {
  const { data, error, loading, reload } = useApi<Stats>("/api/stats", { pollMs: 30_000 });
  if (error) return <ErrorNote message={error} onRetry={reload} />;

  const onboarding = data && (!data.browser || data.scrapes24h + data.recipes === 0 || data.watchers === 0 || !data.ai.configured);

  return (
    <>
      <PageHeader title="Dashboard" description="What Scaper is watching, and what changed." />

      {loading || !data ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Watchers" value={data.activeWatchers} hint={data.failingWatchers ? <span className="text-warning">{data.failingWatchers} need attention</span> : `${data.watchers} total`} icon={<Radar className="size-4" />} />
            <Stat label="Changes, 24h" value={data.changes24h} hint="Detected by watchers" icon={<Bell className="size-4" />} />
            <Stat label="Tracked products" value={data.products} hint="Price history builds over time" icon={<Tag className="size-4" />} />
            <Stat label="Scrapes, 24h" value={data.scrapes24h} hint={`${data.recipes} saved recipes`} icon={<ScanSearch className="size-4" />} />
          </div>

          {onboarding && (
            <Card className="mt-6">
              <CardHeader title="Get set up" description="Four steps to get the most out of Scaper." />
              <ol className="divide-y divide-border px-5">
                <Step done={data.browser} title="Install the scraping browser">
                  Run <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">npm run setup:browser</code> once in the project folder. Fast mode works without it.
                </Step>
                <Step done={data.scrapes24h + data.recipes > 0} title="Scrape your first page" href="/scrape" cta="Open scraper">Paste any URL. Auto mode finds lists, tables, products and links for you.</Step>
                <Step done={data.watchers > 0} title="Watch a page for changes" href="/watchers" cta="New watcher">Get an alert when a page, a section or a price changes.</Step>
                <Step done={data.ai.configured} title="Connect your own AI model (optional)" href="/settings" cta="Settings">Any OpenAI-compatible API: OpenAI, OpenRouter, Groq, Ollama, LM Studio.</Step>
              </ol>
            </Card>
          )}

          <div className="mt-6 grid gap-6 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <CardHeader title="Recent alerts" actions={<Link href="/notifications" className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">All alerts <ArrowRight className="size-4" /></Link>} />
              {data.recentAlerts.length === 0 ? (
                <EmptyState icon={<Bell className="size-5" />} title="No alerts yet">When a watcher sees a change or a price drops, it shows up here and on your desktop.</EmptyState>
              ) : (
                <ul className="divide-y divide-border">
                  {data.recentAlerts.map((n) => (
                    <li key={n.id} className="flex gap-3 px-5 py-3">
                      {n.kind === "system" ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" /> : <Bell className="mt-0.5 size-4 shrink-0 text-accent" />}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{n.title}</p>
                        <p className="line-clamp-2 text-sm whitespace-pre-line text-muted">{n.body}</p>
                      </div>
                      <span className="shrink-0 text-xs text-muted">{timeAgo(n.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <div className="space-y-6 lg:col-span-2">
              <Card>
                <CardHeader title="Next checks" />
                {data.upcoming.length === 0 ? (
                  <p className="px-5 py-6 text-sm text-muted">No active watchers. <Link href="/watchers" className="text-accent hover:underline">Create one</Link>.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {data.upcoming.map((w) => (
                      <li key={w.id}>
                        <Link href={`/watchers/${w.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2/50">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{w.name}</p>
                            <p className="truncate text-xs text-muted">{hostOf(w.url)}</p>
                          </div>
                          {w.last_status && w.last_status !== "ok" && <Badge tone="warning">{w.last_status}</Badge>}
                          <span className="text-xs text-muted tabular-nums">{timeAgo(w.next_check_at)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card className="p-5">
                <h2 className="font-semibold">System</h2>
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between gap-2"><dt className="text-muted">Scheduler</dt><dd>{data.scheduler.running ? <Badge tone="success">running</Badge> : <Badge tone="warning">stopped</Badge>}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-muted">Browser</dt><dd>{data.browser ? <Badge tone="success">installed</Badge> : <Badge tone="warning"><Terminal className="size-3" /> npm run setup:browser</Badge>}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-muted">AI model</dt><dd>{data.ai.configured ? <Badge tone="success"><Bot className="size-3" /> {data.ai.usage.requests} calls today</Badge> : <Link href="/settings" className="text-accent hover:underline">Not connected</Link>}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-muted">Jobs running</dt><dd className="tabular-nums">{data.scheduler.activeJobs}</dd></div>
                </dl>
              </Card>
            </div>
          </div>
        </>
      )}
      {loading && !data && <LoadingRows />}
    </>
  );
}
