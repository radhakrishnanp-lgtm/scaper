"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Crosshair, FlaskConical, Globe, Plus, Save, Trash2, Wand2, XCircle, Zap } from "lucide-react";
import { watcherSchema, defaultWatcherOptions, type Condition, type FetchMode, type NotifyChannels, type WatcherOptions, type WatchTarget } from "@/lib/schemas";
import { api, ClientApiError, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { hostOf } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { ElementPicker } from "./element-picker";
import { ChannelPicker, ScheduleField, type ScheduleValue } from "./form-bits";
import { StepsEditor } from "./steps-editor";
import { useToast } from "./toast";
import { Badge, Button, Callout, Card, Checkbox, Field, IconButton, Input, Kbd, Section, Segmented, Select, Switch, TagInput, Textarea } from "./ui";
import { blankCondition, CONDITION_LABEL, conditionText, DAYS, TARGETS, targetInfo, type WatcherView } from "./watcher-bits";

export type WatcherDraft = {
  name: string; url: string; mode: FetchMode; target: WatchTarget; condition: Condition; notify: NotifyChannels; enabled: boolean;
  ignoreText: string; options: WatcherOptions; tags: string[]; schedule: ScheduleValue;
};

const DEFAULT_NOTIFY: NotifyChannels = { desktop: true, webhook: false, telegram: false, discord: false, slack: false, ntfy: false, email: false, whatsapp: false };

export function blankWatcher(url = "", name = "", type: WatchTarget["type"] = "page"): WatcherDraft {
  return {
    name, url, mode: "browser", target: blankTarget(type), condition: { type: "any_change" }, notify: DEFAULT_NOTIFY, enabled: true,
    ignoreText: "", options: defaultWatcherOptions(), tags: [], schedule: { kind: "interval", minutes: 60, cron: "0 9 * * *" },
  };
}

export function draftFromWatcher(w: WatcherView): WatcherDraft {
  return {
    name: w.name, url: w.url, mode: w.mode, target: w.target, condition: w.condition, notify: w.notify, enabled: w.enabled,
    ignoreText: w.ignore_lines.join("\n"), options: w.options, tags: w.tags,
    schedule: { kind: w.options.cron ? "cron" : "interval", minutes: w.interval_minutes, cron: w.options.cron ?? "0 9 * * *" },
  };
}

function blankTarget(type: WatchTarget["type"]): WatchTarget {
  switch (type) {
    case "selector": return { type, selector: "" };
    case "price": return { type, selector: "" };
    case "visual": return { type, selector: "", threshold: 1 };
    case "json": return { type, path: "" };
    case "sitemap": return { type, include: "" };
    case "status": return { type, maxMs: null };
    default: return { type } as WatchTarget;
  }
}

const fullUrlOf = (u: string) => (u && !/^https?:\/\//i.test(u.trim()) ? `https://${u.trim()}` : u.trim());

function buildPayload(d: WatcherDraft) {
  return {
    name: d.name.trim() || (d.url ? hostOf(fullUrlOf(d.url)) : ""), url: fullUrlOf(d.url), mode: targetInfo(d.target.type).forcedMode ?? d.mode,
    target: d.target, condition: d.condition, notify: d.notify, enabled: d.enabled, tags: d.tags,
    intervalMinutes: d.schedule.minutes,
    ignoreLines: d.ignoreText.split("\n").map((l) => l.trim()).filter(Boolean),
    options: { ...d.options, cron: d.schedule.kind === "cron" ? d.schedule.cron.trim() || null : null },
  };
}

type Preview = { content: string; lines: number; chars: number; value: number | null; inStock: boolean | null; note: string; results: { type: string; met: boolean; reason: string }[]; met: boolean };

/** One rule: its type and the inputs that type needs. */
function ConditionEditor({ value, onChange, target, onRemove, errors, prefix }: {
  value: Condition; onChange: (c: Condition) => void; target: WatchTarget["type"]; onRemove?: () => void; errors: Record<string, string>; prefix: string;
}) {
  const allowed = targetInfo(target).conditions;
  const scopeSelect = (c: Extract<Condition, { scope: unknown }>) => (
    <Select aria-label="Where to look" className="sm:w-52" value={c.scope} onChange={(e) => onChange({ ...c, scope: e.target.value as "all" | "added" | "removed" })}>
      <option value="all">anywhere in the content</option>
      <option value="added">only in added lines</option>
      <option value="removed">only in removed lines</option>
    </Select>
  );
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-start">
      <Select aria-label="Rule" className="sm:w-56" value={value.type} onChange={(e) => onChange(blankCondition(e.target.value as Condition["type"]))}>
        {allowed.map((t) => <option key={t} value={t}>{target === "status" && t === "above" ? "Slower than (ms)" : target === "status" && t === "any_change" ? "Status changes" : CONDITION_LABEL[t]}</option>)}
      </Select>
      <div className="min-w-0 flex-1 space-y-2">
        {(value.type === "contains" || value.type === "not_contains") && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input aria-label="Text" invalid={Boolean(errors[`${prefix}.text`])} value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} placeholder={target === "status" ? "down" : "In stock"} />
            {target !== "status" && scopeSelect(value)}
          </div>
        )}
        {value.type === "regex" && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input aria-label="Pattern" className="font-mono text-xs" invalid={Boolean(errors[`${prefix}.pattern`])} value={value.pattern} onChange={(e) => onChange({ ...value, pattern: e.target.value })} placeholder="(remote|hybrid).*engineer" />
            {scopeSelect(value)}
          </div>
        )}
        {(value.type === "below" || value.type === "above") && (
          <Input aria-label="Value" type="number" step="any" min={0} className="sm:w-48" value={Number.isFinite(value.value) ? value.value : ""} onChange={(e) => onChange({ ...value, value: Number(e.target.value) })} placeholder={target === "status" ? "2000" : "1999"} />
        )}
        {(value.type === "drop_percent" || value.type === "rise_percent") && (
          <div className="flex items-center gap-2"><Input aria-label="Percent" type="number" step="any" min={0.1} className="w-28" value={value.percent} onChange={(e) => onChange({ ...value, percent: Number(e.target.value) })} /><span className="text-sm text-muted">% or more since the last check</span></div>
        )}
        {value.type === "ai" && (
          <Textarea aria-label="Question for the AI" rows={2} invalid={Boolean(errors[`${prefix}.question`])} value={value.question} onChange={(e) => onChange({ ...value, question: e.target.value })} placeholder="Only if a new backend developer job in Chennai appears" />
        )}
        <p className="text-xs text-muted">
          {value.type === "any_change" && (target === "visual" ? "When more than the threshold of pixels change." : target === "status" ? "Up → down, down → up, or slow." : "Any difference after your filters.")}
          {value.type === "in_stock" && "When the product changes from unavailable to available."}
          {value.type === "ai" && "Your fast model reads each change and decides. One AI call per change; page text is treated as data, never as instructions."}
          {(value.type === "contains" || value.type === "not_contains" || value.type === "regex") && value.scope === "all" && "Alerts once when this becomes true, not on every check."}
          {(value.type === "below" || value.type === "above") && (target === "page" ? "Tip: watch “Part of a page” or “Price” so Scaper knows which number to read." : "Alerts once when this becomes true.")}
        </p>
        {Object.entries(errors).filter(([k]) => k.startsWith(prefix)).map(([k, m]) => <p key={k} className="text-xs text-danger">{m}</p>)}
      </div>
      {onRemove && <IconButton size="sm" label="Remove rule" onClick={onRemove}><Trash2 className="size-4" /></IconButton>}
    </div>
  );
}

export function WatcherEditor({ id, initial }: { id?: string; initial: WatcherDraft }) {
  const router = useRouter();
  const toast = useToast();
  const [d, setD] = useState<WatcherDraft>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [sample, setSample] = useState("");
  const [useSample, setUseSample] = useState(false);
  const [picker, setPicker] = useState(false);
  const tags = useApi<{ tags: string[] }>("/api/watchers");
  const [saved] = useState(() => JSON.stringify(buildPayload(initial)));

  const o = d.options;
  const info = targetInfo(d.target.type);
  const payload = useMemo(() => buildPayload(d), [d]);
  const dirty = JSON.stringify(payload) !== saved;
  const url = fullUrlOf(d.url);
  const validUrl = /^https?:\/\/[^\s/]+\.[^\s]+|^https?:\/\/localhost/.test(url);
  const textTarget = !["visual", "status"].includes(d.target.type);
  const set = <K extends keyof WatcherDraft>(k: K, v: WatcherDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const setOpt = <K extends keyof WatcherOptions>(k: K, v: WatcherOptions[K]) => setD((x) => ({ ...x, options: { ...x.options, [k]: v } }));

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const changeTarget = (type: WatchTarget["type"]) => {
    const allowed = targetInfo(type).conditions;
    setD((x) => ({
      ...x, target: blankTarget(type),
      condition: allowed.includes(x.condition.type) ? x.condition : type === "price" ? { type: "drop_percent", percent: 5 } : { type: "any_change" },
      options: { ...x.options, moreConditions: x.options.moreConditions.filter((c) => allowed.includes(c.type)), triggerOn: type === "feed" || type === "sitemap" ? "added" : x.options.triggerOn },
    }));
    setPreview(null);
  };

  const validate = () => {
    const parsed = watcherSchema.safeParse(payload);
    if (parsed.success) { setErrors({}); return parsed.data; }
    setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join(".") || "_", i.message])));
    return null;
  };

  const save = async () => {
    const body = validate();
    if (!body) { toast.error("Please fix the highlighted fields"); return; }
    setSaving(true);
    try {
      const { watcher } = await api<{ watcher: WatcherView }>(id ? `/api/watchers/${id}` : "/api/watchers", { method: id ? "PUT" : "POST", body });
      toast.success(id ? "Watcher saved" : "Watcher created", id ? undefined : "The first check saves a baseline; alerts start from the next change.");
      if (body.notify.desktop && "Notification" in window && Notification.permission === "default") void Notification.requestPermission();
      router.push(`/watchers/${watcher.id}`);
    } catch (e) {
      if (e instanceof ClientApiError && e.fields) setErrors(e.fields);
      toast.error("Could not save", errorText(e));
    } finally { setSaving(false); }
  };

  const test = async () => {
    const body = validate();
    if (!body) { toast.error("Please fix the highlighted fields first"); return; }
    setTesting(true); setPreviewError(null);
    try { setPreview(await api<Preview>("/api/watchers/preview", { body: { watcher: body, sample: useSample ? sample : undefined } })); }
    catch (e) { setPreview(null); setPreviewError(errorText(e)); }
    finally { setTesting(false); }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const err = (k: string) => errors[k];
  const conditions = [d.condition, ...o.moreConditions];

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-6">
        <Card className="p-5">
          <Section title="Page">
            <Field label="URL" error={err("url")}>{(p) => <Input {...p} inputMode="url" value={d.url} onChange={(e) => set("url", e.target.value)} placeholder="https://www.example.com/careers" autoFocus={!id && !d.url} />}</Field>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Name" error={err("name")} hint="Shown in alerts. Defaults to the site name.">{(p) => <Input {...p} value={d.name} onChange={(e) => set("name", e.target.value)} placeholder={validUrl ? hostOf(url) : "Careers page"} />}</Field>
              <Field label="Tags">{(p) => <TagInput id={p.id} value={d.tags} onChange={(v) => set("tags", v)} suggestions={tags.data?.tags ?? []} />}</Field>
            </div>
          </Section>
        </Card>

        <Card className="p-5">
          <Section title="What to watch">
            <div role="radiogroup" aria-label="Watch target" className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {TARGETS.map((t) => (
                <button key={t.type} type="button" role="radio" aria-checked={d.target.type === t.type} onClick={() => changeTarget(t.type)}
                  className={cn("rounded-xl border p-3 text-left transition-colors", d.target.type === t.type ? "border-accent bg-accent-soft/40" : "border-border hover:border-accent/50")}>
                  <span className={cn(d.target.type === t.type ? "text-accent" : "text-muted")}>{t.icon}</span>
                  <p className="mt-1.5 text-sm font-medium">{t.label}</p>
                  <p className="text-xs text-muted">{t.description}</p>
                </button>
              ))}
            </div>

            {(d.target.type === "selector" || d.target.type === "price" || d.target.type === "visual") && (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <Field className="flex-1" label={d.target.type === "selector" ? "Element (CSS selector)" : d.target.type === "price" ? "Price element (optional)" : "Only this area (optional)"} error={err("target.selector")}
                  hint={d.target.type === "price" ? "Empty = detect the product price and stock automatically (Amazon, Flipkart and most shops)." : d.target.type === "visual" ? "Empty = the whole visible page." : "Only this element is compared, so ads and dates elsewhere don't cause alerts."}>
                  {(p) => <Input {...p} className="font-mono text-xs" value={d.target.type === "selector" || d.target.type === "price" || d.target.type === "visual" ? d.target.selector : ""} onChange={(e) => setD((x) => ({ ...x, target: { ...x.target, selector: e.target.value } as WatchTarget }))} placeholder={d.target.type === "price" ? ".a-price .a-offscreen" : "#main .listing"} />}
                </Field>
                <Button variant="secondary" icon={<Crosshair className="size-4" />} disabled={!validUrl} onClick={() => setPicker(true)}>Pick on page</Button>
              </div>
            )}
            {d.target.type === "visual" && (
              <Field label="Alert when at least this % of pixels change" hint="1% ignores tiny shifts; raise it for pages with small animations.">
                {(p) => <Input {...p} type="number" min={0.01} max={100} step="any" className="max-w-32" value={d.target.type === "visual" ? d.target.threshold : 1} onChange={(e) => setD((x) => ({ ...x, target: { ...(x.target as Extract<WatchTarget, { type: "visual" }>), threshold: Number(e.target.value) } }))} />}
              </Field>
            )}
            {d.target.type === "json" && (
              <Field label="Path in the JSON" hint="Like data.items[0].price. Empty = the whole response." error={err("target.path")}>
                {(p) => <Input {...p} className="font-mono text-xs" value={d.target.type === "json" ? d.target.path : ""} onChange={(e) => setD((x) => ({ ...x, target: { type: "json", path: e.target.value } }))} placeholder="data.price" />}
              </Field>
            )}
            {d.target.type === "sitemap" && (
              <Field label="Only URLs matching" hint="Glob like /blog/* or /regex/. Empty = every URL.">
                {(p) => <Input {...p} className="font-mono text-xs" value={d.target.type === "sitemap" ? d.target.include : ""} onChange={(e) => setD((x) => ({ ...x, target: { type: "sitemap", include: e.target.value } }))} placeholder="/product/*" />}
              </Field>
            )}
            {d.target.type === "status" && (
              <Field label="Count as slow above (ms)" hint="Optional. Empty = only up or down matters.">
                {(p) => <Input {...p} type="number" min={100} className="max-w-40" value={d.target.type === "status" ? d.target.maxMs ?? "" : ""} onChange={(e) => setD((x) => ({ ...x, target: { type: "status", maxMs: e.target.value ? Number(e.target.value) : null } }))} placeholder="3000" />}
              </Field>
            )}
            {d.target.type === "feed" && <p className="text-sm text-muted">Each feed item becomes one line, so “added lines” means new posts.</p>}

            {!info.forcedMode && (
              <div>
                <p className="mb-1.5 text-sm font-medium">Load with</p>
                <Segmented label="Fetch mode" value={d.mode} onChange={(v) => set("mode", v)} options={[{ value: "auto", label: "Smart", icon: <Wand2 className="size-4" /> }, { value: "browser", label: "Browser", icon: <Globe className="size-4" /> }, { value: "fast", label: "Fast", icon: <Zap className="size-4" /> }]} />
              </div>
            )}
            {info.forcedMode && <p className="text-xs text-muted">Always loaded in {info.forcedMode === "fast" ? "fast HTTP" : "Browser"} mode.</p>}
            {validUrl && <ElementPicker url={url} open={picker} onClose={() => setPicker(false)} itemSelector="" steps={d.mode === "browser" ? o.steps : []}
              onPick={(a) => { if (a.kind === "field") { setD((x) => ({ ...x, target: { ...x.target, selector: a.selector } as WatchTarget })); setPicker(false); } }} />}
          </Section>
        </Card>

        <Card className="p-5">
          <Section title="Alert me when" description={conditions.length > 1 ? undefined : "Add more rules to combine them, e.g. price below ₹2,000 and back in stock."}>
            {conditions.length > 1 && (
              <div className="flex items-center gap-2 text-sm">
                <span>Alert when</span>
                <Segmented label="Match" value={o.match} onChange={(v) => setOpt("match", v)} options={[{ value: "all", label: "all rules" }, { value: "any", label: "any rule" }]} />
                <span>{o.match === "all" ? "hold" : "holds"}</span>
              </div>
            )}
            <div className="space-y-2">
              <ConditionEditor value={d.condition} onChange={(c) => set("condition", c)} target={d.target.type} errors={errors} prefix="condition" />
              {o.moreConditions.map((c, i) => (
                <ConditionEditor key={i} value={c} target={d.target.type} errors={errors} prefix={`options.moreConditions.${i}`}
                  onChange={(n) => setOpt("moreConditions", o.moreConditions.map((x, k) => (k === i ? n : x)))}
                  onRemove={() => setOpt("moreConditions", o.moreConditions.filter((_, k) => k !== i))} />
              ))}
            </div>
            {info.conditions.length > 1 && o.moreConditions.length < 9 && (
              <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setOpt("moreConditions", [...o.moreConditions, blankCondition(info.conditions.find((t) => t !== d.condition.type) ?? "any_change")])}>Add rule</Button>
            )}
            {textTarget && (
              <Field label="Which changes count" hint="“Only additions” is ideal for job boards, feeds and listings.">
                {(p) => (
                  <Select {...p} className="max-w-xs" value={o.triggerOn} onChange={(e) => setOpt("triggerOn", e.target.value as WatcherOptions["triggerOn"])}>
                    <option value="any">Additions and removals</option>
                    <option value="added">Only additions</option>
                    <option value="removed">Only removals</option>
                  </Select>
                )}
              </Field>
            )}
          </Section>
        </Card>

        {textTarget && (
          <Card className="p-5">
            <Section title="Reduce noise" description="Filters run before comparing, so dates, counters and ads don't trigger alerts.">
              <Field label="Ignore lines containing" hint="One phrase per line, not case-sensitive.">
                {(p) => <Textarea {...p} rows={3} className="font-mono text-xs" value={d.ignoreText} onChange={(e) => set("ignoreText", e.target.value)} placeholder={"Last updated\nviews\nSponsored"} />}
              </Field>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Ignore lines matching (regex)" error={err("options.ignoreRegex")}>{(p) => <Input {...p} className="font-mono text-xs" value={o.ignoreRegex} onChange={(e) => setOpt("ignoreRegex", e.target.value)} placeholder="^\d+ (minutes|hours) ago$" />}</Field>
                <Field label="Keep only lines matching (regex)" error={err("options.onlyMatching")}>{(p) => <Input {...p} className="font-mono text-xs" value={o.onlyMatching} onChange={(e) => setOpt("onlyMatching", e.target.value)} placeholder="Engineer|Developer" />}</Field>
              </div>
              <div className="flex flex-wrap gap-6">
                <Switch label="Ignore numbers" description="Changing counts and prices don't count." checked={o.ignoreNumbers} onChange={(v) => setOpt("ignoreNumbers", v)} />
                <Switch label="Ignore upper/lower case" checked={o.ignoreCase} onChange={(v) => setOpt("ignoreCase", v)} />
              </div>
            </Section>
          </Card>
        )}

        <Card className="p-5">
          <Section title="Schedule">
            <ScheduleField value={d.schedule} onChange={(v) => set("schedule", v)} allowOff={false} label="Check" />
            {(err("intervalMinutes") || err("options.cron")) && <p className="text-sm text-danger">{err("intervalMinutes") ?? err("options.cron")}</p>}
            <div className="rounded-xl border border-border p-3">
              <Switch label="Only during active hours" description="Skip checks at night or on weekends (this computer's time)." checked={o.activeHours.enabled} onChange={(v) => setOpt("activeHours", { ...o.activeHours, enabled: v })} />
              {o.activeHours.enabled && (
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <Field label="From">{(p) => <Input {...p} type="time" className="w-32" value={o.activeHours.start} onChange={(e) => setOpt("activeHours", { ...o.activeHours, start: e.target.value })} />}</Field>
                  <Field label="To">{(p) => <Input {...p} type="time" className="w-32" value={o.activeHours.end} onChange={(e) => setOpt("activeHours", { ...o.activeHours, end: e.target.value })} />}</Field>
                  <div className="flex flex-wrap gap-1" role="group" aria-label="Days">
                    {DAYS.map((day, i) => {
                      const on = o.activeHours.days.includes(i);
                      return <button key={day} type="button" aria-pressed={on} onClick={() => setOpt("activeHours", { ...o.activeHours, days: on ? o.activeHours.days.filter((x) => x !== i) : [...o.activeHours.days, i].sort() })}
                        className={cn("h-9 w-11 rounded-lg border text-xs font-medium", on ? "border-accent bg-accent-soft text-accent" : "border-border text-muted")}>{day}</button>;
                    })}
                  </div>
                </div>
              )}
            </div>
            <p className="text-xs text-muted">After repeated failures Scaper waits longer between checks (up to 8×) and goes back to normal after a success.</p>
          </Section>
        </Card>

        {(info.forcedMode ?? d.mode) === "browser" && (
          <Card className="p-5">
            <Section title="Page actions" description="Done before each check: accept cookies, choose a city, open a tab, search.">
              <StepsEditor steps={o.steps} onChange={(s) => setOpt("steps", s)} url={validUrl ? url : ""} max={20} />
            </Section>
          </Card>
        )}

        <Card className="p-5">
          <Section title="Notifications">
            <ChannelPicker value={d.notify} onChange={(v) => set("notify", v)} />
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Quiet period after an alert" hint="No repeat alerts for this long.">
                {(p) => <Select {...p} value={o.cooldownMinutes} onChange={(e) => setOpt("cooldownMinutes", Number(e.target.value))}>
                  {[0, 15, 60, 180, 360, 720, 1440].map((m) => <option key={m} value={m}>{m === 0 ? "None" : m < 60 ? `${m} minutes` : m < 1440 ? `${m / 60} hour${m > 60 ? "s" : ""}` : "1 day"}</option>)}
                  {![0, 15, 60, 180, 360, 720, 1440].includes(o.cooldownMinutes) && <option value={o.cooldownMinutes}>{o.cooldownMinutes} minutes</option>}
                </Select>}
              </Field>
            </div>
            <div className="flex flex-wrap gap-6">
              {textTarget && <Switch label="AI summary in alerts" description="One line on what changed, from your fast model." checked={o.aiSummary} onChange={(v) => setOpt("aiSummary", v)} />}
              {textTarget && <Switch label="AI decides what's important" description="Your fast model marks each change important or not, using your question and your “Not useful” feedback from the Changes inbox." checked={o.aiImportance} onChange={(v) => setOpt("aiImportance", v)} />}
              {textTarget && o.aiImportance && <Switch label="Only alert on important changes" description="Every change still lands in the Changes inbox." checked={o.importantOnly} onChange={(v) => setOpt("importantOnly", v)} />}
              {d.target.type !== "visual" && (info.forcedMode ?? d.mode) === "browser" && <Switch label="Screenshot with each change" checked={o.screenshot} onChange={(v) => setOpt("screenshot", v)} />}
              <Switch label="Enabled" checked={d.enabled} onChange={(v) => set("enabled", v)} />
            </div>
          </Section>
        </Card>
      </div>

      <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start">
        <Card className="p-4">
          <p className="text-sm font-semibold">Summary</p>
          <p className="mt-2 text-sm text-muted">
            Checks <span className="text-text">{validUrl ? hostOf(url) : "the page"}</span> ({info.label.toLowerCase()}) {d.schedule.kind === "cron" ? `on cron ${d.schedule.cron}` : `every ${d.schedule.minutes >= 60 ? `${d.schedule.minutes / 60} h` : `${d.schedule.minutes} min`}`}{o.activeHours.enabled ? ` between ${o.activeHours.start} and ${o.activeHours.end}` : ""} and alerts when <span className="text-text">{conditions.map((c) => conditionText(c, d.target.type)).join(o.match === "any" ? " or " : " and ")}</span>.
          </p>
          <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
            <Button onClick={save} loading={saving} icon={<Save className="size-4" />}>{id ? "Save changes" : "Create watcher"}</Button>
            <Button variant="secondary" onClick={test} loading={testing} icon={<FlaskConical className="size-4" />}>{testing ? "Reading the page…" : "Test now"}</Button>
            <Checkbox label="Test with sample text instead" checked={useSample} onChange={setUseSample} />
            {useSample && <Textarea aria-label="Sample text" rows={4} className="font-mono text-xs" value={sample} onChange={(e) => setSample(e.target.value)} placeholder="Paste text to check your rules against" />}
            <p className="text-xs text-muted">Testing reads the page once and saves nothing. <Kbd>Ctrl</Kbd> <Kbd>S</Kbd> saves.</p>
            {dirty && <p className="text-xs font-medium text-warning">Unsaved changes</p>}
            {id && <Link prefetch={false} href={`/watchers/${id}`} className="text-center text-sm text-muted hover:text-text">Cancel</Link>}
          </div>
        </Card>

        {Object.keys(errors).length > 0 && (
          <Callout tone="danger" icon={<AlertTriangle className="size-4 text-danger" />} title="Some fields need a fix">
            <ul className="mt-1 space-y-0.5">{Object.entries(errors).slice(0, 6).map(([p, m]) => <li key={p}><span className="font-mono text-xs">{p}</span>: {m}</li>)}</ul>
          </Callout>
        )}
        {previewError && <Callout tone="danger" title="The test failed">{previewError}</Callout>}
        {preview && (
          <Card>
            <div className="border-b border-border p-4">
              <p className={cn("flex items-center gap-2 text-sm font-semibold", preview.met ? "text-success" : "text-muted")}>
                {preview.met ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
                {preview.met ? "Your rules hold right now" : "Your rules don't hold right now"}
              </p>
              <ul className="mt-2 space-y-1 text-xs">
                {preview.results.map((r, i) => <li key={i} className="flex gap-1.5">{r.met ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-muted" />}<span><span className="font-medium">{CONDITION_LABEL[r.type as Condition["type"]] ?? r.type}</span>{r.reason ? `: ${r.reason}` : ""}</span></li>)}
              </ul>
              <p className="mt-2 text-xs text-muted">“Anything changes” rules only fire on a real change after the first check.</p>
            </div>
            <div className="flex flex-wrap gap-2 p-4 pb-2 text-xs">
              <Badge>{preview.lines.toLocaleString("en-IN")} lines</Badge>
              <Badge>{preview.chars.toLocaleString("en-IN")} chars</Badge>
              {preview.value !== null && <Badge tone="accent">value {preview.value.toLocaleString("en-IN")}</Badge>}
              {preview.inStock !== null && <Badge tone={preview.inStock ? "success" : "warning"}>{preview.inStock ? "in stock" : "out of stock"}</Badge>}
            </div>
            {preview.note && <p className="px-4 text-xs text-muted">{preview.note}</p>}
            <pre className="scroll-thin m-4 mt-2 max-h-72 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-[11px] whitespace-pre-wrap">{preview.content.slice(0, 4000) || "(empty)"}</pre>
          </Card>
        )}
      </aside>
    </div>
  );
}
