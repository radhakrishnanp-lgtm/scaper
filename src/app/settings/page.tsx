"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Bot, Database, Download, Globe, Send, ShieldCheck } from "lucide-react";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, CardHeader, ErrorNote, Field, Input, LoadingRows, PageHeader, Select, Switch } from "@/components/ui";
import { api, ClientApiError, errorText } from "@/lib/api-client";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type S = {
  ai: { baseUrl: string; apiKey: string; hasApiKey: boolean; model: string; fastModel: string; dailyRequestLimit: number; maxTokens: number; agentMaxSteps: number };
  scraping: { userAgent: string; minDelaySeconds: number; respectRobots: boolean; proxyUrl: string; maxConcurrency: number; blockHeavyResources: boolean; allowPrivateNetwork: boolean; timeoutSeconds: number };
  notifications: { webhookUrl: string; telegramBotToken: string; hasTelegramToken: boolean; telegramChatId: string };
};
type Resp = { settings: S; usage: { requests: number; tokens: number }; passwordProtected: boolean };

const PROVIDERS = [
  { label: "OpenAI", url: "https://api.openai.com/v1" },
  { label: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  { label: "Groq", url: "https://api.groq.com/openai/v1" },
  { label: "Together", url: "https://api.together.xyz/v1" },
  { label: "DeepSeek", url: "https://api.deepseek.com/v1" },
  { label: "Ollama (local)", url: "http://localhost:11434/v1" },
  { label: "LM Studio (local)", url: "http://localhost:1234/v1" },
];

function Section({ icon, title, description, children, onSave, saving, extra }: { icon: ReactNode; title: string; description: string; children: ReactNode; onSave?: () => void; saving?: boolean; extra?: ReactNode }) {
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2">{icon}{title}</span>} description={description} />
      <form onSubmit={(e) => { e.preventDefault(); onSave?.(); }}>
        <div className="space-y-4 p-5">{children}</div>
        {(onSave || extra) && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
            {extra}
            {onSave && <Button type="submit" loading={saving}>Save</Button>}
          </div>
        )}
      </form>
    </Card>
  );
}

export default function SettingsPage() {
  const toast = useToast();
  const { data, error, loading, reload } = useApi<Resp>("/api/settings");
  const events = useApi<{ events: { id: number; level: string; event: string; data: Record<string, unknown>; created_at: string }[] }>("/api/events");
  const [s, setS] = useState<S | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [tgToken, setTgToken] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    // Copy server values into the editable form once loaded.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (data) setS(data.settings);
  }, [data]);

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading || !s || !data) return <><PageHeader title="Settings" /><Card><LoadingRows /></Card></>;

  const set = <K extends keyof S>(section: K, patch: Partial<S[K]>) => setS({ ...s, [section]: { ...s[section], ...patch } });

  const save = async (section: keyof S) => {
    setSaving(section); setErrors({});
    const body: Record<string, unknown> = { ...s[section] };
    delete body.hasApiKey; delete body.hasTelegramToken;
    if (section === "ai") { delete body.apiKey; if (apiKey) body.apiKey = apiKey; }
    if (section === "notifications") { delete body.telegramBotToken; if (tgToken) body.telegramBotToken = tgToken; }
    try {
      const res = await api<{ settings: S }>("/api/settings", { method: "PUT", body: { [section]: body } });
      setS(res.settings); setApiKey(""); setTgToken("");
      toast.success("Settings saved");
      void events.reload();
    } catch (e) {
      if (e instanceof ClientApiError && e.fields) setErrors(e.fields);
      toast.error("Could not save", errorText(e));
    } finally { setSaving(null); }
  };

  const test = async (channel: string) => {
    setTesting(channel);
    try { const r = await api<{ message: string }>("/api/settings/test", { body: { channel } }); toast.success("It works", r.message); }
    catch (e) { toast.error("Test failed", errorText(e)); } finally { setTesting(null); }
  };

  const clearSecret = async (section: "ai" | "notifications", key: "apiKey" | "telegramBotToken") => {
    try { const res = await api<{ settings: S }>("/api/settings", { method: "PUT", body: { [section]: { [key]: "" } } }); setS(res.settings); toast.success("Removed"); }
    catch (e) { toast.error("Could not remove", errorText(e)); }
  };

  const num = (v: string) => (v === "" ? 0 : Number(v));

  return (
    <>
      <PageHeader title="Settings" description="Everything is stored in the local database on this computer." />
      <div className="space-y-6">
        <Section icon={<Bot className="size-4 text-accent" />} title="AI model" description="Any OpenAI-compatible Chat Completions API. Your key stays on this computer and is only sent to the provider you choose."
          onSave={() => save("ai")} saving={saving === "ai"}
          extra={<>
            <Button type="button" variant="secondary" loading={testing === "ai"} onClick={() => test("ai")} disabled={!s.ai.baseUrl}>Test main model</Button>
            <Button type="button" variant="secondary" loading={testing === "ai_fast"} onClick={() => test("ai_fast")} disabled={!s.ai.baseUrl}>Test fast model</Button>
          </>}>
          <div className="flex flex-wrap gap-2">
            {PROVIDERS.map((p) => <button type="button" key={p.url} onClick={() => set("ai", { baseUrl: p.url })} className="rounded-full border border-border px-3 py-1.5 text-xs text-muted hover:border-accent hover:text-accent">{p.label}</button>)}
          </div>
          <Field label="Base URL" error={errors["ai.baseUrl"]} hint="Usually ends in /v1. Scaper calls {base URL}/chat/completions.">
            {(p) => <Input {...p} placeholder="https://api.openai.com/v1" value={s.ai.baseUrl} onChange={(e) => set("ai", { baseUrl: e.target.value })} />}
          </Field>
          <Field label="API key" hint={s.ai.hasApiKey ? <>Saved ({s.ai.apiKey}). Type a new key to replace it. <button type="button" className="text-danger hover:underline" onClick={() => clearSecret("ai", "apiKey")}>Remove</button></> : "Leave empty for local servers like Ollama."}>
            {(p) => <Input {...p} type="password" autoComplete="off" placeholder={s.ai.hasApiKey ? "••••••••" : "sk-…"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Main model" hint="Used by the agent and AI extraction. Needs tool-calling support for the agent." error={errors["ai.model"]}>
              {(p) => <Input {...p} placeholder="gpt-4.1, llama-3.3-70b-versatile, qwen2.5:14b…" value={s.ai.model} onChange={(e) => set("ai", { model: e.target.value })} />}
            </Field>
            <Field label="Fast model" hint="A small, cheap model for quick jobs: deal ranking, change checks, simple extraction." error={errors["ai.fastModel"]}>
              {(p) => <Input {...p} placeholder="gpt-4.1-mini, llama-3.1-8b-instant, qwen2.5:3b…" value={s.ai.fastModel} onChange={(e) => set("ai", { fastModel: e.target.value })} />}
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Daily request limit" hint={`Used today: ${data.usage.requests} requests, ${data.usage.tokens.toLocaleString("en-IN")} tokens.`} error={errors["ai.dailyRequestLimit"]}>
              {(p) => <Input {...p} type="number" min={1} value={s.ai.dailyRequestLimit} onChange={(e) => set("ai", { dailyRequestLimit: num(e.target.value) })} />}
            </Field>
            <Field label="Max tokens per reply" error={errors["ai.maxTokens"]}>{(p) => <Input {...p} type="number" min={64} value={s.ai.maxTokens} onChange={(e) => set("ai", { maxTokens: num(e.target.value) })} />}</Field>
            <Field label="Agent step limit" hint="Max tool calls per agent run." error={errors["ai.agentMaxSteps"]}>{(p) => <Input {...p} type="number" min={1} max={25} value={s.ai.agentMaxSteps} onChange={(e) => set("ai", { agentMaxSteps: num(e.target.value) })} />}</Field>
          </div>
          <p className="text-xs text-muted">Set a spending limit with your provider too. The daily limit here protects you from runaway loops, not from the provider&apos;s pricing.</p>
        </Section>

        <Section icon={<Globe className="size-4 text-accent" />} title="Scraping" description="Polite defaults keep your IP in good standing: one request at a time per site, a gap between requests, and backing off when a site says slow down."
          onSave={() => save("scraping")} saving={saving === "scraping"}>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Seconds between requests (per site)" error={errors["scraping.minDelaySeconds"]} hint="Random ±20% jitter is added.">{(p) => <Input {...p} type="number" min={1} step="0.5" value={s.scraping.minDelaySeconds} onChange={(e) => set("scraping", { minDelaySeconds: num(e.target.value) })} />}</Field>
            <Field label="Page timeout (seconds)" error={errors["scraping.timeoutSeconds"]}>{(p) => <Input {...p} type="number" min={5} max={120} value={s.scraping.timeoutSeconds} onChange={(e) => set("scraping", { timeoutSeconds: num(e.target.value) })} />}</Field>
            <Field label="Pages at the same time" error={errors["scraping.maxConcurrency"]} hint="Across different sites.">{(p) => (
              <Select {...p} value={s.scraping.maxConcurrency} onChange={(e) => set("scraping", { maxConcurrency: Number(e.target.value) })}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
            )}</Field>
          </div>
          <Field label="User agent (optional)" hint="Leave empty to use the browser's own identity." error={errors["scraping.userAgent"]}>
            {(p) => <Input {...p} placeholder="Default" value={s.scraping.userAgent} onChange={(e) => set("scraping", { userAgent: e.target.value })} />}
          </Field>
          <Field label="Proxy (optional)" hint="Your own proxy, for example on your VPS: http://user:pass@host:port. Used by both fetch modes." error={errors["scraping.proxyUrl"]}>
            {(p) => <Input {...p} placeholder="http://user:pass@203.0.113.10:3128" value={s.scraping.proxyUrl} onChange={(e) => set("scraping", { proxyUrl: e.target.value })} />}
          </Field>
          <div className="divide-y divide-border rounded-xl border border-border px-4">
            <div className="py-3"><Switch checked={s.scraping.respectRobots} onChange={(v) => set("scraping", { respectRobots: v })} label="Respect robots.txt" description="Recommended. Turn off only for sites you own or have permission to scrape." /></div>
            <div className="py-3"><Switch checked={s.scraping.blockHeavyResources} onChange={(v) => set("scraping", { blockHeavyResources: v })} label="Low-footprint mode" description="Skip images, fonts and video in Browser mode. Faster, uses less data and looks lighter to sites." /></div>
            <div className="py-3"><Switch checked={s.scraping.allowPrivateNetwork} onChange={(v) => set("scraping", { allowPrivateNetwork: v })} label="Allow private network" description="Lets Scaper (and the agent) open localhost and 192.168.x.x addresses. Keep off on a VPS." /></div>
          </div>
        </Section>

        <Section icon={<Send className="size-4 text-accent" />} title="Notifications" description="Alerts always appear in Scaper and as desktop notifications while a tab is open. Add a webhook or Telegram to get them anywhere."
          onSave={() => save("notifications")} saving={saving === "notifications"}
          extra={<>
            <Button type="button" variant="secondary" loading={testing === "webhook"} onClick={() => test("webhook")} disabled={!s.notifications.webhookUrl}>Test webhook</Button>
            <Button type="button" variant="secondary" loading={testing === "telegram"} onClick={() => test("telegram")} disabled={!s.notifications.hasTelegramToken}>Test Telegram</Button>
          </>}>
          <Field label="Webhook URL" hint="Scaper POSTs JSON {event, title, body, url, data}. Works with n8n, Zapier, Make, Discord/Slack bridges or your own server." error={errors["notifications.webhookUrl"]}>
            {(p) => <Input {...p} type="url" placeholder="https://hooks.example.com/scaper" value={s.notifications.webhookUrl} onChange={(e) => set("notifications", { webhookUrl: e.target.value })} />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Telegram bot token" hint={s.notifications.hasTelegramToken ? <>Saved ({s.notifications.telegramBotToken}). <button type="button" className="text-danger hover:underline" onClick={() => clearSecret("notifications", "telegramBotToken")}>Remove</button></> : "Create a bot with @BotFather."}>
              {(p) => <Input {...p} type="password" autoComplete="off" placeholder={s.notifications.hasTelegramToken ? "••••••••" : "123456:ABC…"} value={tgToken} onChange={(e) => setTgToken(e.target.value)} />}
            </Field>
            <Field label="Telegram chat ID" hint="Message your bot, then open api.telegram.org/bot<token>/getUpdates to find it.">
              {(p) => <Input {...p} placeholder="123456789" value={s.notifications.telegramChatId} onChange={(e) => set("notifications", { telegramChatId: e.target.value })} />}
            </Field>
          </div>
        </Section>

        <Section icon={<Database className="size-4 text-accent" />} title="Data and security" description="Your data lives in data/scaper.db. Back up that folder, or download a JSON export.">
          <div className="flex flex-wrap items-center gap-3">
            <a href="/api/data/export" className="inline-flex h-11 items-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-medium shadow-card hover:bg-surface-2"><Download className="size-4" />Download backup (JSON)</a>
            <span className="flex items-center gap-2 text-sm text-muted"><ShieldCheck className="size-4" />{data.passwordProtected ? <>Password login <Badge tone="success">on</Badge></> : <>Password login <Badge>off</Badge> Set SCAPER_APP_PASSWORD before exposing Scaper on a VPS.</>}</span>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">Activity log</p>
            {!events.data?.events.length ? <p className="text-sm text-muted">No activity yet.</p> : (
              <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-xl border border-border text-sm">
                {events.data.events.map((e) => (
                  <li key={e.id} className="flex items-center gap-3 px-3 py-2">
                    <Badge tone={e.level === "warn" ? "warning" : e.level === "error" ? "danger" : "neutral"}>{e.event}</Badge>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{Object.entries(e.data).filter(([k]) => !/id$/i.test(k)).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" ")}</span>
                    <span className="shrink-0 text-xs text-muted">{timeAgo(e.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>
      </div>
    </>
  );
}
