"use client";

import { useState } from "react";
import { Button, Field, Input, Select, Switch, Textarea, Segmented } from "./ui";
import { Dialog } from "./dialog";
import { useToast } from "./toast";
import { api, ClientApiError, errorText } from "@/lib/api-client";
import type { Condition, FetchMode, NotifyChannels, WatchTarget } from "@/lib/schemas";
import { hostOf } from "@/lib/format";

export type WatcherView = {
  id: string; name: string; url: string; mode: FetchMode; target: WatchTarget; condition: Condition; notify: NotifyChannels;
  ignore_lines: string[]; interval_minutes: number; enabled: boolean; last_checked_at: string | null; next_check_at: string | null;
  last_status: string | null; last_error: string | null; last_value: number | null; fail_count: number; check_count: number; change_count: number;
  created_at: string;
};

const INTERVALS = [5, 15, 30, 60, 180, 360, 720, 1440, 10080];
const intervalLabel = (m: number) => (m < 60 ? `Every ${m} min` : m < 1440 ? `Every ${m / 60} h` : m === 1440 ? "Daily" : "Weekly");

export function conditionText(c: Condition) {
  switch (c.type) {
    case "any_change": return "Any change";
    case "contains": return `Contains “${c.text}”`;
    case "not_contains": return `“${c.text}” disappears`;
    case "below": return `Value below ${c.value}`;
    case "above": return `Value above ${c.value}`;
    case "drop_percent": return `Drops ${c.percent}%+`;
    case "ai": return "AI decides";
  }
}

type Initial = Partial<WatcherView> & { url?: string; name?: string };

export function WatcherDialog({ open, onClose, initial, onSaved }: { open: boolean; onClose: () => void; initial?: Initial; onSaved: (w: WatcherView) => void }) {
  return (
    <Dialog open={open} onClose={onClose} wide title={initial?.id ? "Edit watcher" : "New watcher"} description="Scaper checks the page on a schedule and alerts you when your rule matches.">
      {open && <WatcherForm initial={initial} onCancel={onClose} onSaved={onSaved} />}
    </Dialog>
  );
}

function WatcherForm({ initial, onCancel, onSaved }: { initial?: Initial; onCancel: () => void; onSaved: (w: WatcherView) => void }) {
  const toast = useToast();
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [mode, setMode] = useState<FetchMode>(initial?.mode ?? "browser");
  const [targetType, setTargetType] = useState<WatchTarget["type"]>(initial?.target?.type ?? "page");
  const [selector, setSelector] = useState(initial?.target && "selector" in initial.target ? initial.target.selector ?? "" : "");
  const c = initial?.condition;
  const [condType, setCondType] = useState<Condition["type"]>(c?.type ?? "any_change");
  const [text, setText] = useState(c && "text" in c ? c.text : "");
  const [value, setValue] = useState(c && "value" in c ? String(c.value) : c && "percent" in c ? String(c.percent) : "");
  const [question, setQuestion] = useState(c && "question" in c ? c.question : "");
  const [intervalMinutes, setIntervalMinutes] = useState(initial?.interval_minutes ?? 60);
  const [notify, setNotify] = useState<NotifyChannels>(initial?.notify ?? { desktop: true, webhook: false, telegram: false });
  const [ignore, setIgnore] = useState((initial?.ignore_lines ?? []).join("\n"));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const numericCond = condType === "below" || condType === "above" || condType === "drop_percent";

  const condition = (): Condition => {
    switch (condType) {
      case "contains": case "not_contains": return { type: condType, text };
      case "below": case "above": return { type: condType, value: Number(value) };
      case "drop_percent": return { type: condType, percent: Number(value) };
      case "ai": return { type: "ai", question };
      default: return { type: "any_change" };
    }
  };

  const submit = async () => {
    setBusy(true);
    setErrors({});
    const target: WatchTarget = targetType === "page" ? { type: "page" } : targetType === "selector" ? { type: "selector", selector } : { type: "price", selector };
    const body = {
      name: name || hostOf(url), url, mode, target, condition: condition(), notify, intervalMinutes, enabled: initial?.enabled ?? true,
      ignoreLines: ignore.split("\n").map((l) => l.trim()).filter(Boolean),
    };
    try {
      const res = initial?.id
        ? await api<{ watcher: WatcherView }>(`/api/watchers/${initial.id}`, { method: "PUT", body })
        : await api<{ watcher: WatcherView }>("/api/watchers", { body });
      toast.success(initial?.id ? "Watcher updated" : "Watcher created", initial?.id ? undefined : "The first check saves a baseline.");
      if (notify.desktop && "Notification" in window && Notification.permission === "default") void Notification.requestPermission();
      onSaved(res.watcher);
    } catch (e) {
      if (e instanceof ClientApiError && e.fields) setErrors(e.fields);
      toast.error("Could not save watcher", errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Page URL" error={errors.url} className="sm:col-span-2">
          {(p) => <Input {...p} type="url" inputMode="url" required placeholder="https://www.example.com/product/123" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus={!initial?.url} />}
        </Field>
        <Field label="Name" error={errors.name} hint="Shown in alerts.">
          {(p) => <Input {...p} placeholder="Headphones price" value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Check" error={errors.intervalMinutes}>
          {(p) => (
            <Select {...p} value={intervalMinutes} onChange={(e) => setIntervalMinutes(Number(e.target.value))}>
              {[...new Set([...INTERVALS, intervalMinutes])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{intervalLabel(m)}</option>)}
            </Select>
          )}
        </Field>
      </div>

      <div>
        <p className="mb-1.5 text-sm font-medium">What to watch</p>
        <Segmented label="Watch target" value={targetType} onChange={setTargetType} options={[
          { value: "page", label: "Whole page" }, { value: "selector", label: "Part of page" }, { value: "price", label: "A price" },
        ]} />
        {targetType !== "page" && (
          <Field className="mt-3" label={targetType === "price" ? "Price element (optional)" : "CSS selector"} error={errors["target.selector"]}
            hint={targetType === "price" ? "Leave empty to detect the product price automatically (works on Amazon and most shops)." : "Only this part is compared, which avoids noise from ads and dates."}>
            {(p) => <Input {...p} className="font-mono" placeholder={targetType === "price" ? ".price .amount" : "#main .listing"} value={selector} onChange={(e) => setSelector(e.target.value)} required={targetType === "selector"} />}
          </Field>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Alert me when" error={errors["condition.type"]}>
          {(p) => (
            <Select {...p} value={condType} onChange={(e) => setCondType(e.target.value as Condition["type"])}>
              <option value="any_change">Anything changes</option>
              <option value="contains">The page contains some text</option>
              <option value="not_contains">Some text disappears</option>
              <option value="below">A value goes below</option>
              <option value="above">A value goes above</option>
              <option value="drop_percent">A value drops by %</option>
              <option value="ai">The AI says the change matters</option>
            </Select>
          )}
        </Field>
        {(condType === "contains" || condType === "not_contains") && (
          <Field label="Text" error={errors["condition.text"]} hint="Not case-sensitive.">{(p) => <Input {...p} required placeholder="In stock" value={text} onChange={(e) => setText(e.target.value)} />}</Field>
        )}
        {numericCond && (
          <Field label={condType === "drop_percent" ? "Percent" : "Value"} error={errors["condition.value"] ?? errors["condition.percent"]} hint={targetType === "page" ? "Tip: pick “A price” or a selector so Scaper knows which number to read." : undefined}>
            {(p) => <Input {...p} required type="number" step="any" min="0" placeholder={condType === "drop_percent" ? "10" : "1999"} value={value} onChange={(e) => setValue(e.target.value)} />}
          </Field>
        )}
      </div>
      {condType === "ai" && (
        <Field label="What change matters to you?" error={errors["condition.question"]} hint="When the page changes, your fast AI model reads the change and decides. Uses one AI call per change.">
          {(p) => <Textarea {...p} required placeholder="Alert me only if a new job posting for a backend developer in Bangalore appears" value={question} onChange={(e) => setQuestion(e.target.value)} />}
        </Field>
      )}

      <div className="rounded-xl border border-border p-4">
        <p className="mb-2 text-sm font-medium">Notify me by</p>
        <Switch checked={notify.desktop} onChange={(v) => setNotify({ ...notify, desktop: v })} label="Desktop notification" description="Pops up while Scaper is open in a browser tab. Every alert is also kept in Alerts." />
        <Switch checked={notify.webhook} onChange={(v) => setNotify({ ...notify, webhook: v })} label="Webhook" description="POST to your URL (Zapier, n8n, Make, your own server). Set it in Settings." />
        <Switch checked={notify.telegram} onChange={(v) => setNotify({ ...notify, telegram: v })} label="Telegram" description="Message from your own bot. Set it in Settings." />
      </div>

      <details className="rounded-xl border border-border p-4" open={Boolean(ignore)}>
        <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
        <div className="mt-4 space-y-4">
          <div>
            <p className="mb-1.5 text-sm font-medium">Load with</p>
            <Segmented label="Fetch mode" value={mode} onChange={setMode} options={[{ value: "browser", label: "Browser" }, { value: "fast", label: "Fast (no JavaScript)" }]} />
          </div>
          <Field label="Ignore lines containing" hint="One phrase per line. Removes noise such as dates, visitor counters or rotating ads.">
            {(p) => <Textarea {...p} className="font-mono text-xs" placeholder={"Last updated\nviews"} value={ignore} onChange={(e) => setIgnore(e.target.value)} />}
          </Field>
        </div>
      </details>

      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={busy}>{initial?.id ? "Save changes" : "Create watcher"}</Button>
      </div>
    </form>
  );
}
