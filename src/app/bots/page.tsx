"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BotMessageSquare, CalendarClock, Hand, Play, Plus, Zap } from "lucide-react";
import { BotEditor, BotStatus, EVENT_LABEL, PERMISSIONS, TEMPLATES, type BotView, type Targets } from "@/components/bot-editor";
import { useLiveEvents } from "@/components/live";
import { useToast } from "@/components/toast";
import { Badge, Button, Callout, Card, EmptyState, ErrorNote, LoadingRows, PageHeader, Switch } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { dateTime, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";

type List = { bots: BotView[]; limit: number; targets: Targets };

function BotCard({ bot, onChanged }: { bot: BotView; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async () => {
    setBusy("run");
    try { await api(`/api/bots/${bot.id}/run`, { body: {} }); toast.success(`${bot.name} is running`); onChanged(); }
    catch (e) { toast.error("Could not start the bot", errorText(e)); } finally { setBusy(null); }
  };
  const toggle = async (on: boolean) => {
    setBusy("toggle");
    try { await api(`/api/bots/${bot.id}`, { method: "PUT", body: { enabled: on } }); onChanged(); }
    catch (e) { toast.error(on ? "Could not turn it on" : "Could not pause it", errorText(e)); } finally { setBusy(null); }
  };
  const perm = PERMISSIONS.find((p) => p.value === bot.permission)!;
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-2xl" aria-hidden>{bot.emoji}</span>
        <div className="min-w-0 flex-1">
          <Link href={`/bots/${bot.id}`} className="font-semibold hover:underline">{bot.name}</Link>
          <p className="line-clamp-2 text-sm text-muted">{bot.role}</p>
        </div>
        <BotStatus bot={bot} />
      </div>
      <div className="flex flex-wrap gap-1.5 text-xs">
        <Badge><CalendarClock className="size-3" />{bot.scheduleText}</Badge>
        {bot.triggers.length > 0 && <Badge><Zap className="size-3" />{bot.triggers.length === 1 ? EVENT_LABEL[bot.triggers[0]!.event] : `${bot.triggers.length} events`}</Badge>}
        <Badge>{perm.icon}{perm.label}</Badge>
      </div>
      <p className="text-xs text-muted">
        {bot.last_run_at ? <>Last run <time title={dateTime(bot.last_run_at)}>{timeAgo(bot.last_run_at)}</time> · {bot.run_count} run{bot.run_count === 1 ? "" : "s"}</> : "Has not run yet"}
        {bot.enabled && bot.next_run_at && <> · next <time title={dateTime(bot.next_run_at)}>{timeAgo(bot.next_run_at)}</time></>}
        {bot.finished_reason && <> · {bot.finished_reason}</>}
      </p>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <Switch checked={bot.enabled} disabled={busy === "toggle"} onChange={(v) => void toggle(v)} label={bot.enabled ? "On" : "Paused"} />
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" icon={<Play className="size-4" />} loading={busy === "run"} disabled={bot.running} onClick={() => void run()}>Run now</Button>
          <Link href={`/bots/${bot.id}`} className="inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium text-accent hover:bg-accent-soft">Open</Link>
        </div>
      </div>
    </Card>
  );
}

function BotsPage() {
  const router = useRouter();
  const list = useApi<List>("/api/bots");
  const [creating, setCreating] = useQueryState<string>("new", "");
  useLiveEvents((e) => { if (e.type === "bot") void list.reload(); });
  const bots = list.data?.bots ?? [];
  const active = bots.filter((b) => b.enabled).length;
  return (
    <div>
      <PageHeader title="Bots" description="Your own agents. Each has one job, runs on a schedule or when something happens, keeps its own memory and tells you on your channels."
        actions={<Button icon={<Plus className="size-4" />} onClick={() => setCreating("pick")} disabled={Boolean(list.data && active >= list.data.limit)}>New bot</Button>} />
      {list.error ? <ErrorNote message={list.error} onRetry={list.reload} /> : !list.data ? <LoadingRows rows={3} /> : bots.length === 0 ? (
        <EmptyState icon={<BotMessageSquare className="size-5" />} title="No bots yet" action={<Button icon={<Plus className="size-4" />} onClick={() => setCreating("pick")}>Create your first bot</Button>}>
          A bot does one job for you again and again: hunt price drops, send a morning deal digest, look after failing tasks, explain website changes, or research on request. Start from one of these:
          <span className="mt-3 flex flex-wrap justify-center gap-2">
            {TEMPLATES.slice(0, 4).map((t) => <button key={t.id} type="button" className="rounded-full border border-border px-3 py-1 text-sm hover:border-accent" onClick={() => setCreating(t.id)}>{t.draft.emoji} {t.title}</button>)}
          </span>
        </EmptyState>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted">{active} of {list.data.limit} bots on. Bots pause while private mode is on.</p>
          {bots.some((b) => b.permission === "ask" && b.running) && (
            <Callout tone="warning" icon={<Hand className="size-4" />} title="A bot may be waiting for you">Open a working bot to see if it asks for your OK.</Callout>
          )}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{bots.map((b) => <BotCard key={b.id} bot={b} onChanged={() => void list.reload()} />)}</div>
        </div>
      )}
      {creating && (
        <BotEditor bot={null} targets={list.data?.targets ?? null} template={creating === "pick" ? undefined : creating} onClose={() => setCreating("")}
          onSaved={(b) => { setCreating(""); void list.reload(); router.push(`/bots/${b.id}`); }} />
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense><BotsPage /></Suspense>;
}
