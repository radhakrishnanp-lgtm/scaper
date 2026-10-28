"use client";

import type { FetchMode } from "@/lib/schemas";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell, Globe, Hash, Mail, MessageCircle, MessageSquareText, Send, Smartphone, Webhook } from "lucide-react";
import type { NotifyChannels, Pagination } from "@/lib/schemas";
import type { PublicSettings } from "@/server/repo/settings";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { useApi } from "@/lib/use-api";
import { Badge, Field, Input, Segmented, Select } from "./ui";

export const CHANNELS: { key: keyof NotifyChannels; label: string; icon: React.ReactNode }[] = [
  { key: "desktop", label: "Desktop & inbox", icon: <Bell className="size-4" /> },
  { key: "telegram", label: "Telegram", icon: <Send className="size-4" /> },
  { key: "email", label: "Email", icon: <Mail className="size-4" /> },
  { key: "whatsapp", label: "WhatsApp", icon: <MessageSquareText className="size-4" /> },
  { key: "discord", label: "Discord", icon: <MessageCircle className="size-4" /> },
  { key: "slack", label: "Slack", icon: <Hash className="size-4" /> },
  { key: "ntfy", label: "ntfy push", icon: <Smartphone className="size-4" /> },
  { key: "webhook", label: "Webhook", icon: <Webhook className="size-4" /> },
];

/** Which alert channels are set up in Settings. */
export function useConfiguredChannels() {
  const { data } = useApi<{ settings: PublicSettings }>("/api/settings");
  const n = data?.settings.notifications;
  if (!n) return null;
  return {
    desktop: true,
    webhook: Boolean(n.webhookUrl),
    telegram: Boolean(n.hasTelegramToken && n.telegramChatId),
    discord: Boolean(n.discordWebhookUrl),
    slack: Boolean(n.slackWebhookUrl),
    ntfy: Boolean(n.ntfyUrl),
    email: Boolean(n.smtpHost && n.emailTo),
    whatsapp: n.whatsappProvider === "callmebot" ? Boolean(n.hasCallmebotKey && n.whatsappTo) : Boolean(n.hasWhatsappToken && n.whatsappPhoneId && n.whatsappTo),
  } satisfies Record<keyof NotifyChannels, boolean>;
}

/** Toggle chips for the alert channels; channels not set up yet link to Settings. */
export function ChannelPicker({ value, onChange }: { value: NotifyChannels; onChange: (v: NotifyChannels) => void }) {
  const configured = useConfiguredChannels();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {CHANNELS.map((c) => {
          const ready = configured?.[c.key] ?? true;
          const on = value[c.key];
          return (
            <button
              key={c.key}
              type="button"
              role="switch"
              aria-checked={on}
              onClick={() => onChange({ ...value, [c.key]: !on })}
              className={cn(
                "inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors",
                on ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface text-muted hover:text-text",
              )}
              title={ready ? undefined : `${c.label} is not set up yet (Settings → Alerts)`}
            >
              {c.icon}{c.label}
              {on && !ready && <Badge tone="warning">not set up</Badge>}
            </button>
          );
        })}
      </div>
      {configured && CHANNELS.some((c) => value[c.key] && !configured[c.key]) && (
        <p className="text-xs text-warning">Some chosen channels are not set up. <Link prefetch={false} href="/settings?tab=alerts" className="font-medium underline">Set them up in Settings</Link>; alerts still reach the inbox.</p>
      )}
    </div>
  );
}

const INTERVALS = [
  { v: 5, l: "5 minutes" }, { v: 15, l: "15 minutes" }, { v: 30, l: "30 minutes" }, { v: 60, l: "1 hour" }, { v: 180, l: "3 hours" },
  { v: 360, l: "6 hours" }, { v: 720, l: "12 hours" }, { v: 1440, l: "1 day" }, { v: 10080, l: "1 week" },
];

const CRON_PRESETS = [
  { v: "0 9 * * *", l: "Every day at 09:00" }, { v: "0 9 * * 1-5", l: "Weekdays at 09:00" }, { v: "0 */2 * * *", l: "Every 2 hours" },
  { v: "*/30 9-18 * * 1-5", l: "Every 30 min, office hours" }, { v: "0 8 * * 1", l: "Mondays at 08:00" },
];

/** Shows the next runs of a cron expression as you type, or what's wrong with it. */
export function CronPreview({ cron }: { cron: string }) {
  const [state, setState] = useState<{ runs?: string[]; error?: string } | null>(null);
  useEffect(() => {
    if (!cron.trim()) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api<{ runs: string[] }>(`/api/schedule/preview?cron=${encodeURIComponent(cron)}`, { signal: ctrl.signal })
        .then((d) => setState({ runs: d.runs })).catch((e) => { if ((e as Error).name !== "AbortError") setState({ error: (e as Error).message }); });
    }, 350);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [cron]);
  if (!state || !cron.trim()) return null;
  if (state.error) return <p className="text-xs text-danger">{state.error}</p>;
  return (
    <div className="text-xs text-muted">
      Next runs: {state.runs?.slice(0, 3).map((r) => new Date(r).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })).join(" · ")}
    </div>
  );
}

export type ScheduleValue = { kind: "off" | "interval" | "cron"; minutes: number; cron: string };

/** Off / every N minutes / cron, with presets and a live preview. */
export function ScheduleField({ value, onChange, allowOff = true, minMinutes = 1, label = "Schedule" }: {
  value: ScheduleValue; onChange: (v: ScheduleValue) => void; allowOff?: boolean; minMinutes?: number; label?: string;
}) {
  const options = [
    ...(allowOff ? [{ value: "off" as const, label: "Manual" }] : []),
    { value: "interval" as const, label: "Every…" },
    { value: "cron" as const, label: "Cron" },
  ];
  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1.5 text-sm font-medium">{label}</p>
        <Segmented label={label} value={value.kind} onChange={(k) => onChange({ ...value, kind: k })} options={options} />
      </div>
      {value.kind === "interval" && (
        <Field label="Run every">
          {(p) => (
            <Select {...p} className="max-w-xs" value={value.minutes} onChange={(e) => onChange({ ...value, minutes: Number(e.target.value) })}>
              {INTERVALS.filter((i) => i.v >= minMinutes).map((i) => <option key={i.v} value={i.v}>{i.l}</option>)}
              {!INTERVALS.some((i) => i.v === value.minutes) && <option value={value.minutes}>{value.minutes} minutes</option>}
            </Select>
          )}
        </Field>
      )}
      {value.kind === "cron" && (
        <div className="space-y-2">
          <Field label="Cron expression" hint={<>minute hour day month weekday, in this computer&apos;s time zone. <a className="text-accent hover:underline" href="https://crontab.guru" target="_blank" rel="noreferrer noopener">Help</a></>}>
            {(p) => <Input {...p} className="max-w-sm font-mono" value={value.cron} onChange={(e) => onChange({ ...value, cron: e.target.value })} placeholder="0 9 * * 1-5" />}
          </Field>
          <div className="flex flex-wrap gap-1.5">
            {CRON_PRESETS.map((c) => (
              <button key={c.v} type="button" onClick={() => onChange({ ...value, cron: c.v })} className={cn("h-7 rounded-full border px-2.5 text-xs", value.cron === c.v ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:text-text")}>{c.l}</button>
            ))}
          </div>
          <CronPreview cron={value.cron} />
        </div>
      )}
    </div>
  );
}

/** Lines → count, with ranges expanded the way the server does it (rough preview). */
export function urlListCount(text: string) {
  let n = 0;
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let count = 1;
    for (const m of line.matchAll(/\{(-?\d+)\.\.(-?\d+)(?:\.\.(\d+))?\}|\{([^{}]+,[^{}]*)\}/g)) {
      if (m[4] !== undefined) count *= m[4].split(",").length;
      else count *= Math.floor(Math.abs(Number(m[2]) - Number(m[1])) / Math.max(1, Number(m[3] ?? 1))) + 1;
    }
    n += count;
  }
  return Math.min(n, 5000);
}

export function SiteIcon({ url }: { url: string }) {
  return <Globe className="size-4 text-muted" aria-hidden data-url={url} />;
}

/** How to reach the next pages of a list: a Next link, a Next button, Load more, or infinite scroll. */
export function PaginationField({ value, onChange, mode }: { value: Pagination; onChange: (v: Pagination) => void; mode: FetchMode }) {
  const browserOnly = value.type === "click" || value.type === "loadMore" || value.type === "scroll";
  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-[240px_1fr]">
        <Field label="Next pages">
          {(p) => (
            <Select {...p} value={value.type} onChange={(e) => {
              const t = e.target.value as Pagination["type"];
              onChange(t === "none" ? { type: t } : t === "scroll" ? { type: t, times: 10 } : t === "loadMore" ? { type: t, selector: "", times: 5 } : { type: t, selector: "", maxPages: 5 });
            }}>
              <option value="none">Only the start page</option>
              <option value="next">Follow a “Next” link</option>
              <option value="click">Click a “Next” button (Browser)</option>
              <option value="loadMore">Click “Load more” (Browser)</option>
              <option value="scroll">Infinite scroll (Browser)</option>
            </Select>
          )}
        </Field>
        {value.type !== "none" && (
          <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
            {"selector" in value ? (
              <Field label="Button or link selector" hint="Use Pick on page in the Extract tab to find it, or type it.">
                {(p) => <Input {...p} className="font-mono text-xs" placeholder="a.next, li.pagination-next a" value={value.selector} onChange={(e) => onChange({ ...value, selector: e.target.value })} />}
              </Field>
            ) : <div />}
            <Field label={"maxPages" in value ? "Max pages" : "Times"}>
              {(p) => <Input {...p} type="number" min={"maxPages" in value ? 2 : 1} max={500} value={"maxPages" in value ? value.maxPages : value.times}
                onChange={(e) => { const n = Number(e.target.value) || 1; onChange("maxPages" in value ? { ...value, maxPages: Math.max(2, n) } : { ...value, times: Math.max(1, n) } as Pagination); }} />}
            </Field>
          </div>
        )}
      </div>
      {browserOnly && (mode === "fast" || mode === "firecrawl") && <p className="text-xs text-warning">This needs Browser mode. Fast mode cannot click or scroll.</p>}
    </div>
  );
}
