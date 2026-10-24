"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, Bot, Brain, GraduationCap, Check, CircleDollarSign, Gauge, KeyRound, ListPlus, Pencil, Plus, Power, Route, Save, Scale, ShieldCheck, Trash2, Users, X } from "lucide-react";
import type { AiModel, AiProvider, DecisionSettings, ModelRef } from "@/lib/schemas";
import type { MemoryNote } from "@/server/repo/ai";
import { BarChart } from "@/components/charts";
import { ConfirmDialog, Dialog } from "@/components/dialog";
import { Panel, TestButton, useSection, type S, type SettingsResponse } from "@/components/settings-bits";
import { useToast } from "@/components/toast";
import { Badge, Button, Callout, Checkbox, EmptyState, Field, IconButton, Input, Progress, SearchInput, Segmented, Select, Switch, Textarea } from "@/components/ui";
import { api, ClientApiError, errorText } from "@/lib/api-client";
import { lastDays, plural, shortDay } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type PubProvider = AiProvider & { hasApiKey?: boolean };
type Usage = {
  today: { requests: number; tokens: number; cost: number }; month: { c: number; r: number; t: number };
  history: { day: string; requests: number; tokens: number; cost: number }[]; limit: number; budget: number; configured: boolean;
  stats: { totals: { calls: number; errors: number; cached: number; avg_ms: number; fallbacks: number }; byModel: { model: string; provider_name: string | null; calls: number; tokens_in: number; tokens_out: number; cost: number; avg_ms: number | null; errors: number }[] };
};

/** Ready-made settings for popular OpenAI-compatible providers. Anything else works with "Custom". */
const PRESETS: { label: string; name: string; baseUrl: string; auth: AiProvider["auth"]; hint?: string; headers?: { name: string; value: string }[] }[] = [
  { label: "OpenAI", name: "OpenAI", baseUrl: "https://api.openai.com/v1", auth: "bearer" },
  { label: "Azure OpenAI", name: "Azure OpenAI", baseUrl: "https://YOUR-RESOURCE.openai.azure.com/openai/v1", auth: "api-key", hint: "Replace YOUR-RESOURCE. Use your deployment names as model ids." },
  { label: "OpenRouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", auth: "bearer", hint: "Load models fills in context sizes and prices.", headers: [{ name: "X-Title", value: "Scaper" }] },
  { label: "Google Gemini", name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", auth: "bearer" },
  { label: "Groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", auth: "bearer" },
  { label: "Together", name: "Together", baseUrl: "https://api.together.xyz/v1", auth: "bearer" },
  { label: "DeepSeek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", auth: "bearer" },
  { label: "Mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", auth: "bearer" },
  { label: "xAI", name: "xAI", baseUrl: "https://api.x.ai/v1", auth: "bearer" },
  { label: "Fireworks", name: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", auth: "bearer" },
  { label: "Cerebras", name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", auth: "bearer" },
  { label: "Ollama (this PC)", name: "Ollama", baseUrl: "http://localhost:11434/v1", auth: "none" },
  { label: "LM Studio (this PC)", name: "LM Studio", baseUrl: "http://localhost:1234/v1", auth: "none" },
  { label: "vLLM / LiteLLM", name: "My server", baseUrl: "http://localhost:4000/v1", auth: "bearer", hint: "Any OpenAI-compatible server or gateway." },
  { label: "Anthropic (Claude)", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", auth: "bearer", hint: "Anthropic's OpenAI-compatible endpoint." },
  { label: "Other OpenAI-compatible", name: "", baseUrl: "", auth: "bearer", hint: "Paste the base URL from your provider's docs; it usually ends in /v1." },
];

/** Keys that give away their provider, so pasting one picks the right preset. */
const KEY_HINTS: { re: RegExp; preset: string }[] = [
  { re: /^sk-or-/, preset: "OpenRouter" }, { re: /^sk-ant-/, preset: "Anthropic (Claude)" }, { re: /^gsk_/, preset: "Groq" },
  { re: /^xai-/, preset: "xAI" }, { re: /^AIza/, preset: "Google Gemini" }, { re: /^csk-/, preset: "Cerebras" }, { re: /^fw_/, preset: "Fireworks" },
];
const CONTEXT_SIZES = [32_000, 128_000, 200_000, 256_000, 1_000_000, 2_000_000];
const tokensLabel = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}k`);

type Check = { ok: boolean; steps: { label: string; ok: boolean; detail: string }[]; models: AiModel[]; model: string | null; latencyMs: number | null; tools: boolean | null; json: boolean | null };
/** What the last check covered: a change to any of these means the result no longer applies. */
const checkKey = (p: AiProvider) => JSON.stringify([p.baseUrl, p.apiKey, p.auth, p.headers]);

const newModel = (id: string, extra: Partial<AiModel> = {}): AiModel => ({ id, contextWindow: null, inputPrice: 0, outputPrice: 0, tools: null, json: null, ...extra });
const slugId = (name: string, taken: string[]) => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "provider";
  let id = base; let n = 2;
  while (taken.includes(id)) id = `${base}-${n++}`;
  return id;
};
const money = (v: number) => (v >= 1 ? `$${v.toFixed(2)}` : v > 0 ? `$${v.toFixed(4)}` : "$0");
const cap = (v: boolean | null) => (v === null ? <Badge>not tested</Badge> : v ? <Badge tone="success"><Check className="size-3" />yes</Badge> : <Badge tone="danger"><X className="size-3" />no</Badge>);

function ModelPicker({ value, onChange, providers, allowEmpty, label }: { value: ModelRef; onChange: (v: ModelRef) => void; providers: PubProvider[]; allowEmpty?: string; label: string }) {
  const provider = providers.find((p) => p.id === value.providerId);
  const known = provider?.models.some((m) => m.id === value.model);
  const [custom, setCustom] = useState(Boolean(value.model && provider && !known));
  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)]">
      <Select aria-label={`${label}: provider`} value={value.providerId} onChange={(e) => { const p = providers.find((x) => x.id === e.target.value); onChange({ providerId: e.target.value, model: p?.models[0]?.id ?? "" }); setCustom(false); }}>
        {allowEmpty !== undefined && <option value="">{allowEmpty}</option>}
        {!allowEmpty && !value.providerId && <option value="">Choose a provider</option>}
        {providers.map((p) => <option key={p.id} value={p.id}>{p.name}{p.enabled ? "" : " (off)"}</option>)}
      </Select>
      {value.providerId && (custom || !provider?.models.length ? (
        <Input aria-label={`${label}: model id`} className="font-mono text-xs" value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })} placeholder="model id, e.g. gpt-4.1-mini" />
      ) : (
        <Select aria-label={`${label}: model`} value={known ? value.model : ""} onChange={(e) => { if (e.target.value === "__other") { setCustom(true); return; } onChange({ ...value, model: e.target.value }); }}>
          {!known && <option value="">Choose a model</option>}
          {provider!.models.map((m) => <option key={m.id} value={m.id}>{m.id}{m.tools === false ? " (no tools)" : ""}</option>)}
          <option value="__other">Other model id…</option>
        </Select>
      ))}
    </div>
  );
}

function ProviderDialog({ open, initial, taken, onClose, onSave }: {
  open: boolean; initial: PubProvider | null; taken: string[]; onClose: () => void; onSave: (p: PubProvider) => Promise<boolean>;
}) {
  const toast = useToast();
  // A new provider starts as OpenAI; any other OpenAI-compatible service is one click (or one pasted key) away.
  const [p, setP] = useState<PubProvider>(() => initial ?? { id: "", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "", auth: "bearer", headers: [], models: [], timeoutSeconds: 120, enabled: true });
  const [key, setKey] = useState("");
  const [hint, setHint] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<(Check & { key: string }) | null>(null);
  const [unchecked, setUnchecked] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [listing, setListing] = useState(false);
  const [remote, setRemote] = useState<AiModel[] | null>(null);
  const [filter, setFilter] = useState("");
  const [manual, setManual] = useState("");
  const [testing, setTesting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<PubProvider>) => setP((x) => ({ ...x, ...patch }));
  const body = (): AiProvider => {
    const { hasApiKey: _drop, ...rest } = p;
    void _drop;
    return { ...rest, id: rest.id || slugId(rest.name || "provider", taken), apiKey: key || rest.apiKey };
  };

  const loadModels = async () => {
    setListing(true); setErrors({});
    try {
      const r = await api<{ models: AiModel[] }>("/api/ai/models", { body: { provider: body() } });
      setRemote(r.models);
      if (!r.models.length) toast.info("No models listed", "This provider did not list any. Add model ids by hand.");
    } catch (e) {
      if (e instanceof ClientApiError && e.fields) setErrors(Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k.replace(/^provider\./, ""), v])));
      toast.error("Could not load models", errorText(e));
    } finally { setListing(false); }
  };
  const addModel = (m: AiModel) => setP((x) => (x.models.some((y) => y.id === m.id) ? x : { ...x, models: [...x.models, m] }));
  const setModel = (id: string, patch: Partial<AiModel>) => setP((x) => ({ ...x, models: x.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  const testModel = async (id: string) => {
    setTesting(id);
    try {
      const r = await api<{ reply: string; latencyMs: number; json: boolean; tools: boolean | null; notes: string[] }>("/api/ai/test", { body: { provider: body(), model: id } });
      setModel(id, { tools: r.tools, json: r.json });
      const msg = `Answered "${r.reply}" in ${(r.latencyMs / 1000).toFixed(1)}s. JSON mode: ${r.json ? "yes" : "no"}. Tool calling: ${r.tools ? "yes" : r.tools === null ? "not sure" : "no"}.`;
      if (r.tools) toast.success(`${id} works`, msg); else toast.info(`${id} answers, but…`, `${msg} ${r.notes.join(" ")}`);
    } catch (e) { toast.error(`${id} failed`, errorText(e)); } finally { setTesting(null); }
  };
  const applyPreset = (x: (typeof PRESETS)[number]) => { set({ name: x.name, baseUrl: x.baseUrl, auth: x.auth, headers: x.headers ?? [] }); setHint(x.hint); setRemote(null); setCheck(null); };
  const onKey = (v: string) => {
    setKey(v);
    // Only switch presets for a new provider still on a default, never over a URL the person typed.
    if (initial) return;
    const preset = PRESETS.find((x) => x.label === KEY_HINTS.find((h) => h.re.test(v.trim()))?.preset);
    const onDefault = PRESETS.some((x) => x.baseUrl === p.baseUrl && (x.label === "OpenAI" || x.label === "Other OpenAI-compatible"));
    if (preset && onDefault && preset.baseUrl !== p.baseUrl) { applyPreset(preset); toast.info(`That looks like a ${preset.label} key`, `Switched the address to ${preset.baseUrl}.`); }
  };
  const validate = (out: AiProvider) => {
    const local: Record<string, string> = {};
    if (!out.name.trim()) local.name = "Name is required";
    if (!/^https?:\/\/\S+$/i.test(out.baseUrl)) local.baseUrl = "Start with http:// or https://";
    if (out.auth !== "none" && !out.apiKey) local.apiKey = "Paste your API key, or choose No key for a local model";
    setErrors(local);
    return !Object.keys(local).length;
  };
  /** Tries the address, the key and one model without saving anything. */
  const runCheck = async () => {
    const out = body();
    if (!validate(out)) return null;
    setChecking(true); setUnchecked(false);
    try {
      const r = await api<Check>("/api/ai/check", { body: { provider: out } });
      setCheck({ ...r, key: checkKey(out) });
      // Fill in what the check learned: the models offered (when none were added) and the tested model's abilities.
      setP((x) => {
        let models = x.models;
        if (!models.length && r.model) models = [r.models.find((m) => m.id === r.model) ?? newModel(r.model)];
        return { ...x, models: models.map((m) => (m.id === r.model && r.latencyMs !== null ? { ...m, tools: r.tools, json: r.json } : m)) };
      });
      if (r.models.length && !remote) setRemote(r.models);
      return r.ok;
    } catch (e) { toast.error("Could not test the connection", errorText(e)); return null; }
    finally { setChecking(false); }
  };
  const save = async (force = false) => {
    const out = body();
    if (!validate(out)) return;
    // A new or changed key is tested first, so a typo is caught here and not on the first scrape.
    const fresh = check && check.key === checkKey(out);
    if (!force && out.auth !== "none" && (key || !initial) && !(fresh && check.ok)) {
      const ok = fresh ? check.ok : await runCheck();
      if (ok === false) { setUnchecked(true); return; }
      if (ok === null) return;
    }
    setSaving(true);
    const ok = await onSave(out);
    setSaving(false);
    if (ok) onClose();
  };
  const shown = (remote ?? []).filter((m) => !filter || m.id.toLowerCase().includes(filter.toLowerCase())).slice(0, 200);

  return (
    <Dialog open={open} onClose={onClose} xl title={initial ? `Edit ${initial.name}` : "Add an AI provider"} description="Any service or local server with an OpenAI-compatible Chat Completions API."
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" icon={<ShieldCheck className="size-4" />} loading={checking} onClick={() => void runCheck()}>Test connection</Button>
        <Button icon={<Save className="size-4" />} loading={saving || (checking && !check)} onClick={() => void save()}>Save provider</Button>
      </>}>
      <div className="space-y-5">
        {!initial && (
          <div>
            <p className="mb-2 text-sm font-medium">Start from</p>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((x) => (
                <button key={x.label} type="button" onClick={() => applyPreset(x)}
                  className={`h-8 rounded-full border px-3 text-xs ${p.baseUrl === x.baseUrl && p.name === x.name ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:text-text"}`}>{x.label}</button>
              ))}
            </div>
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name" error={errors.name}>{(f) => <Input {...f} value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="My provider" />}</Field>
          <Field label="Base URL" error={errors.baseUrl} hint={hint ?? "Scaper adds /chat/completions. A full endpoint with ?api-version=… also works."}>
            {(f) => <Input {...f} className="font-mono text-xs" value={p.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.example.com/v1" />}
          </Field>
          <Field label="How the key is sent">{(f) => (
            <Select {...f} value={p.auth} onChange={(e) => set({ auth: e.target.value as AiProvider["auth"] })}>
              <option value="bearer">Authorization: Bearer (most providers)</option>
              <option value="api-key">api-key header (Azure)</option>
              <option value="none">No key (local models)</option>
            </Select>
          )}</Field>
          <Field label="API key" error={errors.apiKey} hint={p.hasApiKey ? `Saved (${p.apiKey}). Type a new one to replace it.` : "Stored only in your local database; never sent to the browser. Pasting a key picks its provider."}>
            {(f) => <Input {...f} type="password" autoComplete="off" disabled={p.auth === "none"} value={key} onChange={(e) => onKey(e.target.value)} placeholder={p.hasApiKey ? "••••••••" : p.auth === "none" ? "Not needed" : "sk-…"} />}
          </Field>
        </div>
        {check && <CheckResult check={check} stale={check.key !== checkKey(body())} onSaveAnyway={unchecked ? () => void save(true) : undefined} />}
        {p.hasApiKey && <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => { set({ apiKey: "", hasApiKey: false }); setKey(""); }}>Remove saved key (on save)</Button>}

        <details className="rounded-xl border border-border p-3" open={p.headers.length > 0}>
          <summary className="cursor-pointer text-sm font-medium">Extra headers and timeout</summary>
          <div className="mt-3 space-y-2">
            {p.headers.map((h, i) => (
              <div key={i} className="flex gap-2">
                <Input aria-label="Header name" className="w-48 font-mono text-xs" value={h.name} onChange={(e) => set({ headers: p.headers.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)) })} placeholder="X-Header" />
                <Input aria-label="Header value" className="min-w-0 flex-1 font-mono text-xs" value={h.value} onChange={(e) => set({ headers: p.headers.map((x, k) => (k === i ? { ...x, value: e.target.value } : x)) })} placeholder="value" />
                <IconButton label="Remove header" onClick={() => set({ headers: p.headers.filter((_, k) => k !== i) })}><Trash2 className="size-4" /></IconButton>
              </div>
            ))}
            <div className="flex flex-wrap items-end gap-4">
              <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => set({ headers: [...p.headers, { name: "", value: "" }] })} disabled={p.headers.length >= 10}>Add header</Button>
              <Field label="Timeout (s)">{(f) => <Input {...f} type="number" min={5} max={900} className="w-28" value={p.timeoutSeconds} onChange={(e) => set({ timeoutSeconds: Number(e.target.value) || 120 })} />}</Field>
              <Switch label="Enabled" checked={p.enabled} onChange={(v) => set({ enabled: v })} />
            </div>
            <p className="text-xs text-muted">Header values with key, token or secret in the name are hidden after saving.</p>
          </div>
        </details>

        <div className="rounded-xl border border-border">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div>
              <p className="text-sm font-medium">Models</p>
              <p className="text-xs text-muted">Add the models you want to use. Prices (US$ per million tokens) let Scaper track cost; a test checks JSON mode and tool calling.</p>
            </div>
            <Button size="sm" variant="secondary" icon={<ListPlus className="size-4" />} loading={listing} onClick={loadModels}>Load models from provider</Button>
          </div>
          {remote && (
            <div className="border-b border-border px-4 py-3">
              <div className="mb-2 flex items-center gap-2">
                <SearchInput value={filter} onChange={setFilter} placeholder={`Search ${remote.length} models`} className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => setRemote(null)}>Done</Button>
              </div>
              <ul className="max-h-56 overflow-y-auto rounded-lg border border-border">
                {shown.map((m) => {
                  const added = p.models.some((x) => x.id === m.id);
                  return (
                    <li key={m.id} className="flex items-center gap-3 border-b border-border px-3 py-1.5 text-xs last:border-b-0">
                      <Checkbox checked={added} onChange={(v) => (v ? addModel(m) : set({ models: p.models.filter((x) => x.id !== m.id) }))} label={m.id} hideLabel />
                      <span className="min-w-0 flex-1 truncate font-mono">{m.id}</span>
                      {m.contextWindow && <span className="text-muted">{Math.round(m.contextWindow / 1000)}k ctx</span>}
                      {(m.inputPrice > 0 || m.outputPrice > 0) && <span className="text-muted">${m.inputPrice} / ${m.outputPrice}</span>}
                    </li>
                  );
                })}
                {!shown.length && <li className="px-3 py-2 text-xs text-muted">No match.</li>}
              </ul>
            </div>
          )}
          <div className="space-y-2 px-4 py-3">
            {p.models.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="text-left text-xs text-muted"><tr><th className="py-1 pr-2 font-medium">Model id</th><th className="px-2 font-medium">Context (tokens)</th><th className="px-2 font-medium">$ in / 1M</th><th className="px-2 font-medium">$ out / 1M</th><th className="px-2 font-medium">Tools</th><th className="px-2 font-medium">JSON</th><th /></tr></thead>
                  <tbody>
                    {p.models.map((m) => (
                      <tr key={m.id} className="border-t border-border">
                        <td className="py-1.5 pr-2 font-mono text-xs">{m.id}</td>
                        <td className="px-2">
                          <Select aria-label={`Context window of ${m.id}`} className="h-8 w-32" value={m.contextWindow ?? ""} onChange={(e) => setModel(m.id, { contextWindow: e.target.value ? Number(e.target.value) : null })}>
                            <option value="">Default</option>
                            {[...new Set([...CONTEXT_SIZES, ...(m.contextWindow ? [m.contextWindow] : [])])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{tokensLabel(n)}{n === m.contextWindow && !CONTEXT_SIZES.includes(n) ? " (from provider)" : ""}</option>)}
                          </Select>
                        </td>
                        <td className="px-2"><Input aria-label={`Input price of ${m.id}`} type="number" step="0.01" min={0} className="h-8 w-24" value={m.inputPrice} onChange={(e) => setModel(m.id, { inputPrice: Number(e.target.value) || 0 })} /></td>
                        <td className="px-2"><Input aria-label={`Output price of ${m.id}`} type="number" step="0.01" min={0} className="h-8 w-24" value={m.outputPrice} onChange={(e) => setModel(m.id, { outputPrice: Number(e.target.value) || 0 })} /></td>
                        <td className="px-2">{cap(m.tools)}</td>
                        <td className="px-2">{cap(m.json)}</td>
                        <td className="whitespace-nowrap pl-2 text-right">
                          <Button size="sm" variant="ghost" loading={testing === m.id} onClick={() => void testModel(m.id)}>Test</Button>
                          <IconButton label={`Remove ${m.id}`} size="sm" onClick={() => set({ models: p.models.filter((x) => x.id !== m.id) })}><Trash2 className="size-4" /></IconButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="text-sm text-muted">No models yet. Load them from the provider or type a model id below.</p>}
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const id = manual.trim(); if (id) { addModel(newModel(id)); setManual(""); } }}>
              <Input aria-label="Model id to add" className="min-w-0 flex-1 font-mono text-xs" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Add a model id, e.g. gpt-4.1-mini or llama3.1:8b" />
              <Button type="submit" size="sm" variant="secondary" icon={<Plus className="size-4" />} disabled={!manual.trim()}>Add</Button>
            </form>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function CheckResult({ check, stale, onSaveAnyway }: { check: Check; stale: boolean; onSaveAnyway?: () => void }) {
  return (
    <Callout tone={stale ? "neutral" : check.ok ? "success" : "danger"} title={stale ? "Changed since the last test" : check.ok ? "Connection works" : "The connection did not work"}
      action={onSaveAnyway && <Button size="sm" variant="secondary" onClick={onSaveAnyway}>Save anyway</Button>}>
      <ul className="mt-1 space-y-1">
        {check.steps.map((x) => (
          <li key={x.label} className="flex gap-2 text-sm">
            {x.ok ? <Check className="mt-0.5 size-4 shrink-0 text-success" aria-label="ok" /> : <X className="mt-0.5 size-4 shrink-0 text-danger" aria-label="failed" />}
            <span><span className="font-medium">{x.label}:</span> {x.detail}</span>
          </li>
        ))}
      </ul>
    </Callout>
  );
}

function MemoryPanel() {
  const toast = useToast();
  const notes = useApi<{ notes: MemoryNote[] }>("/api/ai/memory");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try { await api("/api/ai/memory", { body: { text } }); setText(""); void notes.reload(); }
    catch (e) { toast.error("Could not save the note", errorText(e)); } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    try { await api(`/api/ai/memory/${id}`, { method: "DELETE" }); void notes.reload(); }
    catch (e) { toast.error("Could not delete", errorText(e)); }
  };
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">Memory</p>
      <p className="text-xs text-muted">Short facts the agent always knows. You can add them here, or tell the agent &quot;remember that …&quot;.</p>
      {notes.data?.notes.length ? (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {notes.data.notes.map((n) => (
            <li key={n.id} className="flex items-start gap-3 px-3 py-2 text-sm">
              <Badge tone={n.source === "agent" ? "accent" : "neutral"}>{n.source === "agent" ? "agent" : "you"}</Badge>
              <span className="min-w-0 flex-1">{n.text}</span>
              <IconButton size="sm" label="Delete note" onClick={() => void remove(n.id)}><Trash2 className="size-4" /></IconButton>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted">{notes.loading ? "Loading…" : "Nothing yet."}</p>}
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim().length > 1) void add(); }}>
        <Input aria-label="New memory note" className="min-w-0 flex-1" value={text} onChange={(e) => setText(e.target.value)} placeholder="I live in Chennai and shop on amazon.in" maxLength={500} />
        <Button type="submit" variant="secondary" loading={busy} disabled={text.trim().length < 2} icon={<Plus className="size-4" />}>Add</Button>
      </form>
    </div>
  );
}

export function AiSettings({ data, onSaved }: { data: SettingsResponse; onSaved: (s: S) => void }) {
  const s = useSection(data.settings.ai, "ai", onSaved);
  const usage = useApi<Usage>("/api/ai/usage");
  const v = s.v;
  const providers = v.providers as PubProvider[];
  const [editing, setEditing] = useState<PubProvider | "new" | null>(null);
  const [deleting, setDeleting] = useState<PubProvider | null>(null);
  const days = lastDays(30);
  const byDay = useMemo(() => new Map((usage.data?.history ?? []).map((h) => [h.day, h])), [usage.data]);

  const saveProviders = async (next: AiProvider[], extra: Record<string, unknown> = {}) => {
    const ok = await s.save({ providers: next, ...extra });
    if (ok) void usage.reload();
    return ok;
  };
  const upsert = async (p: AiProvider) => {
    const exists = providers.some((x) => x.id === p.id);
    const next = exists ? providers.map((x) => (x.id === p.id ? p : x)) : [...providers, p];
    // The first provider with a model becomes the main one, so Scaper works right away.
    const extra: Record<string, unknown> = {};
    if (!v.main.providerId && p.models[0]) extra.main = { providerId: p.id, model: p.models[0].id };
    return saveProviders(next, extra);
  };
  const used = (id: string) => [v.main, v.fast, ...v.fallbacks].some((r) => r.providerId === id);
  const remove = async (p: PubProvider) => {
    const clear = (r: ModelRef) => (r.providerId === p.id ? { providerId: "", model: "" } : r);
    if (await saveProviders(providers.filter((x) => x.id !== p.id), { main: clear(v.main), fast: clear(v.fast), fallbacks: v.fallbacks.filter((r) => r.providerId !== p.id) })) setDeleting(null);
  };
  const moveFallback = (i: number, d: -1 | 1) => {
    const f = [...v.fallbacks];
    const j = i + d;
    if (j < 0 || j >= f.length) return;
    [f[i], f[j]] = [f[j]!, f[i]!];
    s.set({ fallbacks: f });
  };
  const u = usage.data;
  const saveBtn = <Button icon={<Save className="size-4" />} loading={s.saving} onClick={() => void s.save()}>Save</Button>;

  return (
    <div className="space-y-6">
      <Panel title="Your AI providers" icon={<KeyRound className="size-4 text-muted" />}
        description="Add as many OpenAI-compatible endpoints as you like: cloud providers with your key, gateways, or models on this computer."
        footer={<Button icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>Add provider</Button>}>
        {!providers.length ? (
          <EmptyState icon={<Bot className="size-5" />} title="No AI provider yet" action={<Button icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>Add provider</Button>}>
            Scaper works without AI, but the agent, AI extraction, category scrapes and Fix with AI need one. OpenAI, OpenRouter, Groq, Gemini, Ollama and any compatible server work.
          </EmptyState>
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2">
            {providers.map((p) => (
              <li key={p.id} className="rounded-xl border border-border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">{p.name}
                      {!p.enabled && <Badge tone="warning"><Power className="size-3" />off</Badge>}
                      {v.main.providerId === p.id && <Badge tone="accent">main</Badge>}
                      {v.fast.providerId === p.id && <Badge tone="accent">fast</Badge>}
                      {v.fallbacks.some((f) => f.providerId === p.id) && <Badge>fallback</Badge>}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-xs text-muted" title={p.baseUrl}>{p.baseUrl}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <IconButton label={`Edit ${p.name}`} onClick={() => setEditing(p)}><Pencil className="size-4" /></IconButton>
                    <IconButton label={`Delete ${p.name}`} onClick={() => setDeleting(p)}><Trash2 className="size-4" /></IconButton>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
                  <Badge>{p.auth === "none" ? "no key" : p.hasApiKey ? `key ${p.apiKey}` : "key missing"}</Badge>
                  <Badge>{plural(p.models.length, "model")}</Badge>
                  {p.models.some((m) => m.tools) && <Badge tone="success">tool calling</Badge>}
                  {p.headers.length > 0 && <Badge>{plural(p.headers.length, "header")}</Badge>}
                </div>
                {p.models.length > 0 && <p className="mt-2 truncate font-mono text-xs text-muted">{p.models.slice(0, 6).map((m) => m.id).join(" · ")}{p.models.length > 6 ? " …" : ""}</p>}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Which model does what" icon={<Route className="size-4 text-muted" />}
        description="Pick any saved model for each role. If a call fails because of an outage, a rate limit or a bad key, Scaper tries the fallbacks in order."
        footer={<><TestButton channel="ai" label="Test main" /><TestButton channel="ai_fast" label="Test fast" />{saveBtn}</>}>
        {!providers.length ? <p className="text-sm text-muted">Add a provider first.</p> : (
          <div className="space-y-4">
            <Field label="Main model" hint="The agent, category planning and Fix with AI. Use your strongest model with tool calling." error={s.errors["main.model"]}>
              {() => <ModelPicker label="Main model" value={v.main} onChange={(r) => s.set({ main: r })} providers={providers} />}
            </Field>
            <Field label="Fast model" hint="AI extraction, selectors, AI columns, change summaries and deal ranking. Cheaper and quicker.">
              {() => <ModelPicker label="Fast model" value={v.fast} onChange={(r) => s.set({ fast: r })} providers={providers} allowEmpty="Same as main" />}
            </Field>
            <div>
              <p className="mb-2 text-sm font-medium">Fallbacks</p>
              <div className="space-y-2">
                {v.fallbacks.map((f, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="mt-2 w-5 text-xs text-muted tabular-nums">{i + 1}.</span>
                    <div className="min-w-0 flex-1"><ModelPicker label={`Fallback ${i + 1}`} value={f} onChange={(r) => s.set({ fallbacks: v.fallbacks.map((x, k) => (k === i ? r : x)) })} providers={providers} /></div>
                    <IconButton label="Move up" onClick={() => moveFallback(i, -1)} disabled={i === 0}><ArrowUp className="size-4" /></IconButton>
                    <IconButton label="Move down" onClick={() => moveFallback(i, 1)} disabled={i === v.fallbacks.length - 1}><ArrowDown className="size-4" /></IconButton>
                    <IconButton label="Remove fallback" onClick={() => s.set({ fallbacks: v.fallbacks.filter((_, k) => k !== i) })}><Trash2 className="size-4" /></IconButton>
                  </div>
                ))}
                <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} disabled={v.fallbacks.length >= 3} onClick={() => s.set({ fallbacks: [...v.fallbacks, { providerId: providers[0]!.id, model: providers[0]!.models[0]?.id ?? "" }] })}>Add fallback</Button>
              </div>
            </div>
          </div>
        )}
      </Panel>

      <DecisionsPanel value={v.decisions} providers={providers} onChange={(d) => s.set({ decisions: { ...v.decisions, ...d } })} saveBtn={saveBtn} />

      <Panel title="Agent team" icon={<Users className="size-4 text-muted" />}
        description="The agent can act as a supervisor: for bigger jobs it starts helper agents, writes their instructions, examples and decision questions, shares a memory with them and combines their reports. Helpers can only read; changes still go through the agent and your approvals."
        footer={saveBtn}>
        <Switch label="Let the agent start helper agents" description="Off: the agent does everything itself." checked={v.team.enabled} onChange={(x) => s.set({ team: { ...v.team, enabled: x } })} />
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Helpers at once">{(f) => <Select {...f} value={v.team.maxAgents} onChange={(e) => s.set({ team: { ...v.team, maxAgents: Number(e.target.value) } })}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</Select>}</Field>
          <Field label="Steps per helper" hint="Model calls before it must report.">{(f) => <Input {...f} type="number" min={2} max={30} value={v.team.workerSteps} onChange={(e) => s.set({ team: { ...v.team, workerSteps: Math.min(30, Math.max(2, Number(e.target.value) || 2)) } })} />}</Field>
          <Field label="Helper model" hint="The supervisor can pick another per helper.">{(f) => <Select {...f} value={v.team.workerModel} onChange={(e) => s.set({ team: { ...v.team, workerModel: e.target.value as "main" | "fast" } })}><option value="fast">Fast model</option><option value="main">Main model</option></Select>}</Field>
        </div>
        <Switch label="Learn playbooks" description="The supervisor saves helper instructions that worked, rates them after each use and improves them. See them under Agent → Playbooks." checked={v.team.evolve} onChange={(x) => s.set({ team: { ...v.team, evolve: x } })} />
      </Panel>

      <Panel title="Learning" icon={<GraduationCap className="size-4 text-muted" />}
        description="How the agent gets to know Scaper and improves. See what it knows under Agent → Knowledge."
        footer={saveBtn}>
        <Switch label="Give the agent Scaper's guide" description="A short map of every page, tool and your current set-up in each request, plus app_guide for the full A to Z. It is rebuilt from the app, so new features appear on their own." checked={v.learning.guide} onChange={(x) => s.set({ learning: { ...v.learning, guide: x } })} />
        <Switch label="Let it keep notes" description="The agent writes Markdown notes (site quirks, selectors that worked, how-tos, lessons) and reads them before related jobs. Also saved as .md files in the data folder's knowledge folder." checked={v.learning.notes} onChange={(x) => s.set({ learning: { ...v.learning, notes: x } })} />
        <Switch label="Review its own work" description="After each job the fast model scores it from 1 to 5, lists what went wrong and keeps one lesson the agent sees next time. One small extra AI call per job." checked={v.learning.selfReview} onChange={(x) => s.set({ learning: { ...v.learning, selfReview: x } })} />
        <Field label="Review jobs with at least this many tool calls" hint="0 reviews every job.">{(f) => <Input {...f} type="number" min={0} max={20} className="w-28" value={v.learning.reviewMinSteps} onChange={(e) => s.set({ learning: { ...v.learning, reviewMinSteps: Math.min(20, Math.max(0, Number(e.target.value) || 0)) } })} />}</Field>
      </Panel>

      <Panel title="How the AI works" icon={<Gauge className="size-4 text-muted" />} description="Defaults for every AI call. Page text is sized to each model's context window when you set it." footer={saveBtn}>
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="Temperature" hint="0 = exact, higher = more creative.">{(f) => <Input {...f} type="number" min={0} max={2} step={0.1} value={v.temperature} onChange={(e) => s.set({ temperature: Math.min(2, Math.max(0, Number(e.target.value) || 0)) })} />}</Field>
          <Field label="Max tokens per answer" error={s.errors.maxTokens}>{(f) => <Input {...f} type="number" min={64} max={128000} value={v.maxTokens} onChange={(e) => s.set({ maxTokens: Number(e.target.value) || 64 })} />}</Field>
          <Field label="Default context (tokens)" hint="When a model's window is not set. Up to 1M.">{(f) => (
            <Select {...f} value={v.contextTokens} onChange={(e) => s.set({ contextTokens: Number(e.target.value) })}>
              {[...new Set([8_000, 16_000, 24_000, ...CONTEXT_SIZES.filter((n) => n <= 1_000_000), v.contextTokens])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{tokensLabel(n)} tokens</option>)}
            </Select>
          )}</Field>
          <Field label="Agent steps per request">{(f) => <Input {...f} type="number" min={1} max={40} value={v.agentMaxSteps} onChange={(e) => s.set({ agentMaxSteps: Number(e.target.value) || 1 })} />}</Field>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <p className="mb-1.5 text-sm font-medium">When the agent wants to change something</p>
            <Segmented label="Agent approvals" value={v.agentApproval} onChange={(x) => s.set({ agentApproval: x })} options={[{ value: "ask", label: "Ask me first" }, { value: "auto", label: "Go ahead" }]} />
            <p className="mt-1.5 text-xs text-muted">Saving tasks, watchers, tracked products, deleting things and sending alerts. Deleting always asks, even in <p className="mt-1.5 text-xs text-muted">Saving tasks, watchers, tracked products, deleting things and sending alerts.</p>quot;Go ahead<p className="mt-1.5 text-xs text-muted">Saving tasks, watchers, tracked products, deleting things and sending alerts.</p>quot;.</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Reuse identical answers (hours)" hint="0 = off. Saves tokens on re-runs.">{(f) => <Input {...f} type="number" min={0} max={720} value={v.cacheHours} onChange={(e) => s.set({ cacheHours: Number(e.target.value) || 0 })} />}</Field>
            <Field label="Keep the AI log (days)">{(f) => <Input {...f} type="number" min={1} max={365} value={v.keepCallsDays} onChange={(e) => s.set({ keepCallsDays: Number(e.target.value) || 1 })} />}</Field>
          </div>
        </div>
        <Switch label="Keep prompts and replies in the AI log" description="Lets you see exactly what was sent and answered. Off = only model, tokens, cost and timing." checked={v.logPrompts} onChange={(x) => s.set({ logPrompts: x })} />
      </Panel>

      <Panel title="Instructions and memory" icon={<Brain className="size-4 text-muted" />} description="Context the agent gets in every conversation." footer={saveBtn}>
        <Field label="Standing instructions" hint={`${v.instructions.length} / 4000`}>
          {(f) => <Textarea {...f} rows={4} maxLength={4000} value={v.instructions} onChange={(e) => s.set({ instructions: e.target.value })} placeholder={"I live in Chennai, India. Show prices in ₹.\nPrefer amazon.in and flipkart.com. Answer briefly."} />}
        </Field>
        <MemoryPanel />
      </Panel>

      <Panel title="Limits and spend" icon={<CircleDollarSign className="size-4 text-muted" />} description="Guards against runaway costs. Counted on this computer; your provider's bill is the final word." footer={saveBtn}>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Requests per day" error={s.errors.dailyRequestLimit}>{(f) => <Input {...f} type="number" min={1} value={v.dailyRequestLimit} onChange={(e) => s.set({ dailyRequestLimit: Number(e.target.value) || 1 })} />}</Field>
          <Field label="Monthly budget (US$)" hint="0 = no budget. Needs model prices to count.">{(f) => <Input {...f} type="number" min={0} step={1} value={v.monthlyBudget} onChange={(e) => s.set({ monthlyBudget: Number(e.target.value) || 0 })} />}</Field>
        </div>
        {u ? (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <div className="mb-1 flex justify-between text-sm"><span>Today</span><span className="tabular-nums">{u.today.requests} / {u.limit} requests · {u.today.tokens.toLocaleString("en-IN")} tokens · {money(u.today.cost)}</span></div>
                <Progress label="AI requests today" value={u.today.requests} max={u.limit} tone={u.today.requests / u.limit > 0.8 ? "warning" : "accent"} />
              </div>
              <div>
                <div className="mb-1 flex justify-between text-sm"><span>This month</span><span className="tabular-nums">{money(u.month.c)}{u.budget ? ` of $${u.budget}` : ""} · {u.month.r.toLocaleString("en-IN")} requests</span></div>
                <Progress label="AI spend this month" value={u.budget ? u.month.c : 0} max={u.budget || 1} tone={u.budget && u.month.c / u.budget > 0.8 ? "warning" : "accent"} />
              </div>
            </div>
            <BarChart label="AI requests per day" height={130} data={days.map((d) => ({ label: shortDay(d), values: { r: byDay.get(d)?.requests ?? 0 } }))} series={[{ key: "r", label: "Requests", color: "var(--accent)" }]} emptyText="No AI requests in the last 30 days." />
            {u.stats.byModel.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="text-left text-xs text-muted"><tr><th className="py-1 font-medium">Model (30 days)</th><th className="font-medium">Calls</th><th className="font-medium">Tokens</th><th className="font-medium">Cost</th><th className="font-medium">Avg time</th><th className="font-medium">Errors</th></tr></thead>
                  <tbody>{u.stats.byModel.map((m) => (
                    <tr key={`${m.provider_name}-${m.model}`} className="border-t border-border tabular-nums">
                      <td className="py-1.5"><span className="font-mono text-xs">{m.model}</span>{m.provider_name && <span className="text-xs text-muted"> · {m.provider_name}</span>}</td>
                      <td>{m.calls}</td><td>{(m.tokens_in + m.tokens_out).toLocaleString("en-IN")}</td><td>{money(m.cost)}</td><td>{m.avg_ms ? `${(m.avg_ms / 1000).toFixed(1)}s` : "–"}</td><td>{m.errors || "–"}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            <p className="text-sm"><Link prefetch={false} href="/ai-log" className="text-accent hover:underline">Open the AI log</Link> <span className="text-muted">to see every call, with its prompt and reply.</span></p>
          </>
        ) : <div className="skeleton h-32 rounded-lg" />}
      </Panel>

      <Callout icon={<ShieldCheck className="size-4 text-accent" />} title="How Scaper uses your model">
        Pages go to the model as text marked as untrusted data, and instructions found inside them are ignored. Scaper never runs code the model writes: selectors it proposes are tested with a static parser, and its answers are checked against the page. In &quot;Ask me first&quot; mode the agent cannot change anything without your OK.
      </Callout>

      {editing && (
        <ProviderDialog key={editing === "new" ? "new" : editing.id} open initial={editing === "new" ? null : editing} taken={providers.map((p) => p.id)}
          onClose={() => setEditing(null)} onSave={upsert} />
      )}
      <ConfirmDialog open={Boolean(deleting)} onCancel={() => setDeleting(null)} title={`Delete ${deleting?.name ?? "provider"}?`} confirmLabel="Delete"
        body={deleting && used(deleting.id) ? "It is used as the main, fast or a fallback model. Those choices will be cleared." : "Its key is deleted from this computer."}
        onConfirm={() => deleting && void remove(deleting)} />
    </div>
  );
}

type DecisionTest = { model: string; provider: string | null; latencyMs: number; cost: number; urgent: number | null; team: string | null };

/** The decision model: which provider's key, which model, and what Scaper uses it for. */
function DecisionsPanel({ value: d, providers, onChange, saveBtn }: { value: DecisionSettings; providers: PubProvider[]; onChange: (d: Partial<DecisionSettings>) => void; saveBtn: React.ReactNode }) {
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<DecisionTest | null>(null);
  const provider = providers.find((p) => p.id === d.providerId) ?? providers.find((p) => /openrouter\.ai/i.test(p.baseUrl));
  const endpoint = d.url || (provider ? decisionsEndpoint(provider.baseUrl) : "");
  const runTest = async () => {
    setTesting(true); setTest(null);
    try { setTest(await api<DecisionTest>("/api/decisions/test", { method: "POST" })); }
    catch (e) { toast.error("The decision model did not answer", errorText(e)); }
    finally { setTesting(false); }
  };
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    <Panel title="Decision model" icon={<Scale className="size-4 text-muted" />}
      description={<>A model that answers yes/no, pick-one and rating questions with probabilities, such as OpenRouter&apos;s decisions models. Scaper uses it to choose which links hold what you want, to check a page before scraping it, and to double-check the agent. Hard rules always come first; it can only make Scaper more careful. <Link prefetch={false} href="/decisions" className="text-accent hover:underline">Open Decisions</Link></>}
      footer={<><Button size="sm" variant="secondary" loading={testing} disabled={!provider || !d.model} onClick={() => void runTest()}>Test it</Button>{saveBtn}</>}>
      <Switch label="Use a decision model" description="Off: link picking uses your chat model, scrape checks use only the rules, and the agent asks before deleting." checked={d.enabled} onChange={(x) => onChange({ enabled: x })} />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Provider (its key is used)" hint={!providers.some((p) => /openrouter\.ai/i.test(p.baseUrl)) ? "Add OpenRouter under Your AI providers first (choose the OpenRouter preset)." : undefined}>
          {(f) => (
            <Select {...f} value={d.providerId || provider?.id || ""} onChange={(e) => onChange({ providerId: e.target.value })}>
              <option value="">Choose…</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Model" hint="From OpenRouter's decisions models.">{(f) => <Input {...f} className="font-mono text-xs" value={d.model} onChange={(e) => onChange({ model: e.target.value })} placeholder="openai/gpt-6-luna-decisions" />}</Field>
        <Field label="Endpoint" hint={d.url ? "Custom endpoint." : "Worked out from the provider's base URL. Set it only if yours differs."}>
          {(f) => <Input {...f} className="font-mono text-xs" value={d.url} onChange={(e) => onChange({ url: e.target.value })} placeholder={endpoint || "https://openrouter.ai/api/alpha/decisions"} />}
        </Field>
        <Field label="Price per million input tokens (US$)" hint="Used only when the provider does not report the cost.">{(f) => <Input {...f} type="number" min={0} step={0.01} value={d.inputPrice} onChange={(e) => onChange({ inputPrice: Math.max(0, Number(e.target.value) || 0) })} />}</Field>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Checkbox label="Pick links for category scrapes" checked={d.pickLinks} onChange={(x) => onChange({ pickLinks: x })} />
        <Checkbox label="Check pages before scraping" checked={d.scrapeCheck} onChange={(x) => onChange({ scrapeCheck: x })} />
        <Checkbox label="Double-check the agent's changes" checked={d.agentGuard} onChange={(x) => onChange({ agentGuard: x })} />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={`A link counts as a match from ${pct(d.linkThreshold)}`} hint="Lower finds more categories; higher picks only clear ones.">
          {(f) => <input {...f} type="range" min={0.2} max={0.95} step={0.05} value={d.linkThreshold} onChange={(e) => onChange({ linkThreshold: Number(e.target.value) })} className="w-full accent-[var(--accent)]" />}
        </Field>
        <Field label={`A risk is flagged from ${pct(d.riskThreshold)}`} hint="Lower is more careful: more cautions and more questions from the agent.">
          {(f) => <input {...f} type="range" min={0.2} max={0.95} step={0.05} value={d.riskThreshold} onChange={(e) => onChange({ riskThreshold: Number(e.target.value) })} className="w-full accent-[var(--accent)]" />}
        </Field>
      </div>
      {test && (
        <Callout tone="success" icon={<Check className="size-4" />} title={`It works: ${test.model}${test.provider ? ` via ${test.provider}` : ""}`}>
          Asked about a sample support message: urgent {test.urgent === null ? "not answered" : pct(test.urgent)}, team &quot;{test.team ?? "not answered"}&quot;. {(test.latencyMs / 1000).toFixed(2)}s, {money(test.cost)}.
        </Callout>
      )}
    </Panel>
  );
}

/** Mirrors the server: OpenRouter's …/api/v1 becomes …/api/alpha/decisions. */
function decisionsEndpoint(baseUrl: string) {
  try {
    const u = new URL(baseUrl);
    u.pathname = `${u.pathname.replace(/\/+$/, "").replace(/\/(chat\/completions|models)$/, "").replace(/\/v1$/, "")}/alpha/decisions`;
    u.search = "";
    return u.toString();
  } catch { return ""; }
}
