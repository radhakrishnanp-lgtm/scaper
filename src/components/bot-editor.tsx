"use client";

import { useState } from "react";
import { Eye, Hand, Plus, Rocket, Trash2 } from "lucide-react";
import type { BotEvent, BotInput, BotSchedule } from "@/lib/schemas";
import type { Bot } from "@/server/repo/bots";
import { Dialog } from "@/components/dialog";
import { ChannelPicker } from "@/components/form-bits";
import { useToast } from "@/components/toast";
import { Badge, Button, Field, IconButton, Input, Segmented, Select, Switch, Textarea } from "@/components/ui";
import { api, ClientApiError, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";

export type Target = { id: string; name: string };
export type Targets = { tasks: Target[]; watchers: Target[]; products: Target[]; searches: Target[] };

export const EVENT_LABEL: Record<BotEvent, string> = {
  "task.finished": "A task finishes", "task.failed": "A task fails", "task.alert": "A task has a data or health alert",
  "watcher.change": "A watcher sees a change", "price.alert": "A price alert fires", "deal.found": "A deal search finds new deals",
};
const EVENT_TARGET: Record<BotEvent, keyof Targets> = {
  "task.finished": "tasks", "task.failed": "tasks", "task.alert": "tasks", "watcher.change": "watchers", "price.alert": "products", "deal.found": "searches",
};
const TARGET_WORD: Record<keyof Targets, string> = { tasks: "task", watchers: "watcher", products: "product", searches: "deal search" };

export const PERMISSIONS = [
  { value: "read", label: "Read only", icon: <Eye className="size-4" />, help: "Looks, reads and remembers. Never changes your tasks, watchers or settings." },
  { value: "ask", label: "Ask first", icon: <Hand className="size-4" />, help: "Changes wait for your OK. You get an alert with a link, and it waits 30 minutes." },
  { value: "auto", label: "Go ahead", icon: <Rocket className="size-4" />, help: "Makes the changes its job needs without asking. Deleting always asks." },
] as const;

const INTERVALS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const minutesLabel = (m: number) => (m < 60 ? `${m} minutes` : m < 1440 ? `${m / 60} hour${m === 60 ? "" : "s"}` : "day");

type Draft = Omit<BotInput, "notify"> & { notify: BotInput["notify"] };
const NO_CHANNELS = { desktop: true, webhook: false, telegram: false, discord: false, slack: false, ntfy: false, email: false, whatsapp: false };
const BASE: Draft = {
  name: "", emoji: "🤖", role: "", task: "", instructions: "", schedule: { type: "manual" }, triggers: [], condition: "", stopWhen: "",
  permission: "ask", model: "main", maxSteps: 15, helpers: false, memory: true, notify: NO_CHANNELS, notifyMode: "important", cooldownMinutes: 10, selfEval: true,
};

/** Starting points, in the spirit of Grok's bots and ChatGPT's scheduled tasks. */
export const TEMPLATES: { id: string; title: string; blurb: string; draft: Partial<Draft> }[] = [
  {
    id: "price", title: "Price drop hunter", blurb: "Checks your tracked products every 6 hours and tells you about real drops.",
    draft: { name: "Price drop hunter", emoji: "🏷️", role: "Watches my tracked products for real price drops", schedule: { type: "interval", minutes: 360 }, permission: "read",
      task: "Check my tracked products and their price history. Compare each current price with what you remembered last run. Report any product that dropped 10% or more, or is at its lowest price in 30 days, with the link. Save the latest prices in your memory.",
      condition: "a price dropped by 10% or more, or hit its lowest price in 30 days" },
  },
  {
    id: "deals", title: "Morning deal digest", blurb: "Every morning at 9, the five best real deals from your saved deal searches.",
    draft: { name: "Morning deal digest", emoji: "🛍️", role: "Sends me the best real deals each morning", schedule: { type: "daily", time: "09:00", days: [] }, permission: "read", notifyMode: "always",
      task: "Look at my saved deal searches and tracked products. Pick the 5 best real deals today (a real discount against the price history, good rating). For each: name, price, discount and link, in a short table. Skip deals you already sent in the last 3 days (check your memory) and remember what you sent." },
  },
  {
    id: "babysitter", title: "Task babysitter", blurb: "Wakes up when a task fails, finds out why, and suggests or prepares a repair.",
    draft: { name: "Task babysitter", emoji: "🩺", role: "Looks after my scraping tasks when they fail", triggers: [{ event: "task.failed", refId: null }], permission: "ask",
      task: "A task failed. Use task_health and list_runs to find out why. If the selectors broke, start repair_task (it waits for my OK). Tell me in two or three lines what happened and what you did. Remember recurring problems per task." },
  },
  {
    id: "changes", title: "Change explainer", blurb: "When a watcher sees a change, says whether it matters and why.",
    draft: { name: "Change explainer", emoji: "🔎", role: "Explains website changes and tells me only about the ones that matter", triggers: [{ event: "watcher.change", refId: null }], permission: "read",
      task: "A watcher saw a change. Read the change (recent_changes or change_inbox) and decide whether it matters to me, using what you remember about my interests. If it does, explain it in plain words with the link.", condition: "the change is important to me (new item, price, availability, policy or date change), not layout or ads" },
  },
  {
    id: "jobs", title: "Job board watcher", blurb: "Looks for new postings on a careers page every 3 hours until you find one.",
    draft: { name: "Job board watcher", emoji: "💼", role: "Finds new job postings that match what I want", schedule: { type: "interval", minutes: 180 }, permission: "read",
      task: "Open https://example.com/careers (change this to the real page), list the open roles and compare them with the roles you remembered last time. Tell me about new roles that match: backend or data engineering, remote or Bengaluru. Remember the roles you have seen.",
      condition: "there is a new matching role", stopWhen: "I tell you I applied, or the page is gone for good" },
  },
  {
    id: "social", title: "Social trends scout", blurb: "Every morning, finds what is trending on YouTube and Instagram for your topics. Needs Apify; it asks before each paid run until you set it to Go ahead.",
    draft: { name: "Social trends scout", emoji: "📈", role: "Tells me what is trending on social media for my topics", schedule: { type: "daily", time: "08:00", days: [] }, permission: "ask", notifyMode: "always",
      task: "Use apify_run_actor with streamers~youtube-scraper (searchQueries: my topics, sortingOrder: views, dateFilter: today, maxResults: 15) and apify~instagram-hashtag-scraper (hashtags: my topics, resultsType: reels, resultsLimit: 15). My topics: tamil cinema, chennai food (change these). Report the top 5 of each with title, views or likes and the link, and say what is new since yesterday. Remember what you reported." },
  },
  {
    id: "research", title: "Research assistant", blurb: "No schedule: chat with it to research products, shops or topics across websites.",
    draft: { name: "Research assistant", emoji: "🧭", role: "Researches products and topics across websites when I ask", schedule: { type: "manual" }, permission: "read", notifyMode: "off", helpers: true,
      task: "When I ask, research the question across a few good websites, compare what you find in a table with links, and say which option you would pick and why. Remember my preferences (budget, brands I like or avoid)." },
  },
];

function toDraft(bot: Bot | null, template?: Partial<Draft>): Draft {
  if (!bot) return { ...BASE, ...template, notify: { ...NO_CHANNELS, ...template?.notify } };
  return {
    name: bot.name, emoji: bot.emoji, role: bot.role, task: bot.task, instructions: bot.instructions, schedule: bot.schedule, triggers: bot.triggers, condition: bot.condition, stopWhen: bot.stopWhen,
    permission: bot.permission, model: bot.model, maxSteps: bot.maxSteps, helpers: bot.helpers, memory: bot.memory, notify: { ...NO_CHANNELS, ...bot.notify }, notifyMode: bot.notifyMode, cooldownMinutes: bot.cooldownMinutes, selfEval: bot.selfEval,
  };
}

function ScheduleEditor({ value, onChange }: { value: BotSchedule; onChange: (v: BotSchedule) => void }) {
  return (
    <div className="space-y-3">
      <Segmented label="When it runs" value={value.type} onChange={(t) => onChange(t === "manual" ? { type: "manual" } : t === "interval" ? { type: "interval", minutes: 60 } : { type: "daily", time: "09:00", days: [] })}
        options={[{ value: "manual", label: "Only when I run it" }, { value: "interval", label: "Repeat" }, { value: "daily", label: "At a time" }]} />
      {value.type === "interval" && (
        <Field label="Every" className="w-48">{(f) => (
          <Select {...f} value={String(value.minutes)} onChange={(e) => onChange({ type: "interval", minutes: Number(e.target.value) })}>
            {(INTERVALS.includes(value.minutes) ? INTERVALS : [...INTERVALS, value.minutes].sort((a, b) => a - b)).map((m) => <option key={m} value={m}>{minutesLabel(m)}</option>)}
          </Select>
        )}</Field>
      )}
      {value.type === "daily" && (
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Time" className="w-36">{(f) => <Input {...f} type="time" value={value.time} onChange={(e) => onChange({ ...value, time: e.target.value || "09:00" })} />}</Field>
          <div>
            <p className="mb-1.5 text-sm font-medium">Days <span className="font-normal text-muted">(none = every day)</span></p>
            <div className="flex flex-wrap gap-1">
              {DAYS.map((d, i) => {
                const on = value.days.includes(i);
                return (
                  <button key={d} type="button" role="switch" aria-checked={on} aria-label={d}
                    onClick={() => onChange({ ...value, days: on ? value.days.filter((x) => x !== i) : [...value.days, i].sort() })}
                    className={cn("h-9 w-11 rounded-lg border text-sm font-medium", on ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:text-text")}>{d}</button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TriggersEditor({ value, onChange, targets }: { value: BotInput["triggers"]; onChange: (v: BotInput["triggers"]) => void; targets: Targets | null }) {
  const set = (i: number, t: BotInput["triggers"][number]) => onChange(value.map((x, j) => (j === i ? t : x)));
  return (
    <div className="space-y-2">
      {value.map((t, i) => {
        const kind = EVENT_TARGET[t.event];
        const options = targets?.[kind] ?? [];
        return (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <div className="w-64 max-w-full"><Select aria-label="Event" value={t.event} onChange={(e) => set(i, { event: e.target.value as BotEvent, refId: null })}>
              {(Object.keys(EVENT_LABEL) as BotEvent[]).map((ev) => <option key={ev} value={ev}>{EVENT_LABEL[ev]}</option>)}
            </Select></div>
            <div className="w-64 max-w-full"><Select aria-label={`Which ${TARGET_WORD[kind]}`} value={t.refId ?? ""} onChange={(e) => set(i, { ...t, refId: e.target.value || null })}>
              <option value="">Any {TARGET_WORD[kind]}</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.name.slice(0, 60)}</option>)}
              {t.refId && !options.some((o) => o.id === t.refId) && <option value={t.refId}>(deleted {TARGET_WORD[kind]})</option>}
            </Select></div>
            <IconButton label="Remove this event" onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton>
          </div>
        );
      })}
      {value.length < 10 && <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => onChange([...value, { event: "task.failed", refId: null }])}>Add an event</Button>}
    </div>
  );
}

/** Create or edit a bot. New bots start from a template or a blank page. */
export function BotEditor({ bot, targets, onClose, onSaved, template }: { bot: Bot | null; targets: Targets | null; onClose: () => void; onSaved: (b: Bot) => void; template?: string }) {
  const toast = useToast();
  const [d, setD] = useState<Draft>(() => toDraft(bot, TEMPLATES.find((t) => t.id === template)?.draft));
  const [picked, setPicked] = useState<string | null>(bot ? "edit" : template ?? null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(Boolean(bot && (bot.instructions || bot.maxSteps !== 15 || bot.helpers || !bot.memory || bot.model !== "main")));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true); setErrors({});
    try {
      const res = bot ? await api<{ bot: Bot }>(`/api/bots/${bot.id}`, { method: "PUT", body: d }) : await api<{ bot: Bot }>("/api/bots", { body: d });
      toast.success(bot ? "Bot saved" : `${d.name} is ready`, bot ? undefined : res.bot.next_run_at ? "It runs on its schedule. You can also run it now." : "Run it or chat with it from its page.");
      onSaved(res.bot);
    } catch (e) {
      if (e instanceof ClientApiError && e.fields) setErrors(e.fields);
      toast.error("Could not save the bot", errorText(e));
    } finally { setBusy(false); }
  };

  if (!picked) {
    return (
      <Dialog open onClose={onClose} xl title="New bot" description="Pick a starting point. You can change everything on the next screen."
        footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="secondary" onClick={() => setPicked("blank")}>Start blank</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          {TEMPLATES.map((t) => (
            <button key={t.id} type="button" onClick={() => { setD(toDraft(null, t.draft)); setPicked(t.id); }}
              className="rounded-xl border border-border p-4 text-left transition-colors hover:border-accent hover:bg-accent-soft/40">
              <p className="font-medium"><span className="mr-2 text-lg" aria-hidden>{t.draft.emoji}</span>{t.title}</p>
              <p className="mt-1 text-sm text-muted">{t.blurb}</p>
            </button>
          ))}
        </div>
      </Dialog>
    );
  }

  const perm = PERMISSIONS.find((p) => p.value === d.permission)!;
  return (
    <Dialog open onClose={onClose} xl title={bot ? `Edit ${bot.name}` : "New bot"} description="A bot is your own agent with one job. It keeps its own memory and tells you on the channels you pick."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => void save()}>{bot ? "Save" : "Create bot"}</Button></>}>
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-[88px_1fr]">
          <Field label="Emoji" error={errors.emoji}>{(f) => <Input {...f} className="text-center text-lg" value={d.emoji} maxLength={8} onChange={(e) => set("emoji", e.target.value)} />}</Field>
          <Field label="Name" error={errors.name}>{(f) => <Input {...f} value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="Price drop hunter" />}</Field>
        </div>
        <Field label="Role" hint="One line: what this bot is for." error={errors.role}>{(f) => <Input {...f} value={d.role} onChange={(e) => set("role", e.target.value)} placeholder="Watches my tracked products for real price drops" />}</Field>
        <Field label="Its job" hint="What to check or do each run, and what to tell you. Be specific: pages, products, what counts." error={errors.task}>{(f) => <Textarea {...f} className="min-h-28" value={d.task} onChange={(e) => set("task", e.target.value)} />}</Field>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">When it runs</h3>
          <ScheduleEditor value={d.schedule} onChange={(v) => set("schedule", v)} />
          {errors["schedule.minutes"] && <p role="alert" className="text-xs text-danger">{errors["schedule.minutes"]}</p>}
          <div>
            <p className="mb-1.5 text-sm font-medium">Also wake it when</p>
            <TriggersEditor value={d.triggers} onChange={(v) => set("triggers", v)} targets={targets} />
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">What it may do</h3>
          <Segmented label="Permission" value={d.permission} onChange={(v) => set("permission", v)} options={PERMISSIONS.map((p) => ({ value: p.value, label: p.label, icon: p.icon }))} />
          <p className="text-xs text-muted">{perm.help}</p>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">How it tells you</h3>
          <ChannelPicker value={d.notify} onChange={(v) => set("notify", v)} />
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Send messages">{(f) => (
              <Select {...f} value={d.notifyMode} onChange={(e) => set("notifyMode", e.target.value as Draft["notifyMode"])}>
                <option value="important">Only when it finds something</option>
                <option value="always">After every run (its report)</option>
                <option value="off">Never; I check its page</option>
              </Select>
            )}</Field>
            <Field label="Only tell me when (optional)" hint="The bot decides from what it found." error={errors.condition}>{(f) => <Input {...f} value={d.condition} onChange={(e) => set("condition", e.target.value)} placeholder="the price is below ₹2,000" />}</Field>
          </div>
          <Field label="Stop when (optional)" hint="Once this is true the bot tells you and pauses itself." error={errors.stopWhen}>{(f) => <Input {...f} value={d.stopWhen} onChange={(e) => set("stopWhen", e.target.value)} placeholder="the item is back in stock" />}</Field>
        </section>

        <section className="space-y-3">
          <button type="button" className="text-sm font-medium text-accent hover:underline" aria-expanded={more} onClick={() => setMore(!more)}>{more ? "Hide" : "Show"} more options</button>
          {more && (
            <div className="space-y-4">
              <Field label="Instructions (optional)" hint="How to do the job: sources to prefer, tone, format of the report." error={errors.instructions}>{(f) => <Textarea {...f} className="min-h-20" value={d.instructions} onChange={(e) => set("instructions", e.target.value)} />}</Field>
              <div className="grid gap-4 md:grid-cols-3">
                <Field label="Model">{(f) => <Select {...f} value={d.model} onChange={(e) => set("model", e.target.value as Draft["model"])}><option value="main">Main model</option><option value="fast">Fast model (cheaper)</option></Select>}</Field>
                <Field label="Steps per run" error={errors.maxSteps}>{(f) => <Input {...f} type="number" min={2} max={60} value={d.maxSteps} onChange={(e) => set("maxSteps", Number(e.target.value) || 15)} />}</Field>
                <Field label="Minutes between event runs" error={errors.cooldownMinutes}>{(f) => <Input {...f} type="number" min={1} max={1440} value={d.cooldownMinutes} onChange={(e) => set("cooldownMinutes", Number(e.target.value) || 10)} />}</Field>
              </div>
              <Switch checked={d.memory} onChange={(v) => set("memory", v)} label="Own memory" description="Keeps facts and a summary of each run, so it does not repeat itself." />
              <Switch checked={d.helpers} onChange={(v) => set("helpers", v)} label="Helper agents" description="Lets it start helpers for big jobs, when helpers are on in Settings → AI." />
              <Switch checked={d.selfEval} onChange={(v) => set("selfEval", v)} label="Grade itself after each run" description="The fast model scores each run against its job and your 👍/👎, and keeps up to two lessons for next time. Costs one small AI call per run." />
            </div>
          )}
        </section>
      </div>
    </Dialog>
  );
}

export type BotView = Bot & { scheduleText: string };
export function BotStatus({ bot }: { bot: Bot }) {
  if (bot.running) return <Badge tone="accent"><span className="size-1.5 animate-pulse rounded-full bg-accent" />Working</Badge>;
  if (!bot.enabled) return <Badge>{bot.finished_reason ? "Finished" : "Paused"}</Badge>;
  if (bot.last_status === "error") return <Badge tone="danger">Last run failed</Badge>;
  return <Badge tone="success">On</Badge>;
}

