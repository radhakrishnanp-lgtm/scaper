"use client";

import { useState } from "react";
import { EyeOff, Info, Save, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/dialog";
import { Panel, useSection, type S, type SettingsResponse } from "@/components/settings-bits";
import { useToast } from "@/components/toast";
import { Button, Callout, Checkbox, Field, Select, Switch } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";

const SCOPES: { value: string; label: string; hint: string }[] = [
  { value: "scrapes", label: "Scrape and task results", hint: "Saved rows from every run" },
  { value: "agent", label: "Agent conversations", hint: "Questions, answers and steps" },
  { value: "ai_log", label: "AI log", hint: "Prompts, replies, tokens and cost of each call" },
  { value: "ai_cache", label: "Reused AI answers", hint: "The answer cache" },
  { value: "jobs", label: "Finished jobs", hint: "Job list and job logs" },
  { value: "alerts", label: "Notifications", hint: "The in-app inbox" },
  { value: "changes", label: "Watcher history", hint: "Keeps each watcher's latest snapshot" },
  { value: "prices", label: "Price history", hint: "Keeps each product's latest price" },
  { value: "logs", label: "Activity log", hint: "The audit and event log" },
  { value: "site_stats", label: "Site statistics", hint: "Requests, speed and blocks per site" },
  { value: "memory", label: "Agent memory", hint: "Notes the agent remembers" },
  { value: "exports", label: "Export files", hint: "CSV, JSON and Excel files on disk" },
  { value: "backups", label: "Backups", hint: "Old backups still hold everything above" },
  { value: "private", label: "Open private work", hint: "Private results still in memory" },
];
const LABEL = Object.fromEntries(SCOPES.map((x) => [x.value, x.label]));

export function PrivacySettings({ data, onSaved }: { data: SettingsResponse; onSaved: (s: S) => void }) {
  const toast = useToast();
  const s = useSection(data.settings.data, "data", onSaved);
  const [scopes, setScopes] = useState<string[]>(["scrapes", "agent", "ai_log", "ai_cache", "private"]);
  const [age, setAge] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const toggle = (value: string, on: boolean) => setScopes((x) => (on ? [...x, value] : x.filter((y) => y !== value)));
  const wipe = async () => {
    setBusy(true);
    try {
      const r = await api<{ removed: Record<string, number> }>("/api/privacy/wipe", { body: { scopes, olderThanDays: age ? Number(age) : undefined } });
      const total = Object.values(r.removed).reduce((a, b) => a + b, 0);
      toast.success(total ? `Deleted ${total.toLocaleString("en-IN")} items` : "Nothing to delete",
        Object.entries(r.removed).filter(([, n]) => n).map(([k, n]) => `${LABEL[k] ?? k}: ${n}`).join(", ") || undefined);
      setConfirm(false);
    } catch (e) { toast.error("Could not delete", errorText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <Panel title="Private mode" icon={<EyeOff className="size-4 text-muted" />}
        description="Work that leaves nothing on this computer."
        footer={<Button icon={<Save className="size-4" />} loading={s.saving} onClick={() => void s.save()}>Save</Button>}>
        <Switch label="Make quick work private by default"
          description="Quick scrapes, AI extraction, category scrapes and agent chats are kept in memory only: no saved results, no AI log, no site statistics and no activity log. They disappear after an hour (agent chats after two) or when Scaper restarts. You can still turn it on for a single scrape or chat."
          checked={s.v.privateMode} onChange={(x) => s.set({ privateMode: x })} />
        <p className="text-sm text-muted">Saved tasks, watchers and tracked products are never private, because they exist to keep history. Exporting a private result does write a file.</p>
      </Panel>

      <Panel title="Delete history" icon={<Trash2 className="size-4 text-muted" />}
        description="Deleted rows are overwritten and the database is compacted, so they cannot be read back from the file."
        footer={<Button variant="danger" icon={<Trash2 className="size-4" />} disabled={!scopes.length} onClick={() => setConfirm(true)}>Delete selected</Button>}>
        <div className="grid gap-2 sm:grid-cols-2">
          {SCOPES.map((x) => (
            <div key={x.value} className="rounded-lg border border-border px-3 py-2">
              <Checkbox label={x.label} checked={scopes.includes(x.value)} onChange={(on) => toggle(x.value, on)} />
              <p className="ml-6 text-xs text-muted">{x.hint}</p>
            </div>
          ))}
        </div>
        <Field label="Which entries">
          {(f) => (
            <Select {...f} className="max-w-xs" value={age} onChange={(e) => setAge(e.target.value)}>
              <option value="">Everything</option>
              <option value="1">Older than 1 day</option>
              <option value="7">Older than 7 days</option>
              <option value="30">Older than 30 days</option>
              <option value="90">Older than 90 days</option>
            </Select>
          )}
        </Field>
      </Panel>

      <Callout icon={<Info className="size-4 text-accent" />} title="What private mode does not do">
        It hides your work on this computer only. The websites you scrape still see a normal visit from your connection, with Scaper&apos;s user agent, its polite delays and robots.txt rules, and your AI provider still receives the page text you send it. Use a provider on this computer (Ollama or LM Studio) if page text must not leave it.
      </Callout>

      <ConfirmDialog open={confirm} onCancel={() => setConfirm(false)} onConfirm={() => void wipe()} busy={busy} confirmLabel="Delete for good"
        title="Delete this history?"
        body={`${scopes.map((x) => LABEL[x] ?? x).join(", ")}${age ? `, older than ${age} day${age === "1" ? "" : "s"}` : ""}. This cannot be undone.`} />
    </div>
  );
}
