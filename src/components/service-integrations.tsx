"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, Flame, KeyRound, Save, Search, ShieldCheck, Trash2, Users } from "lucide-react";
import { Panel, useSection, type S, type SettingsResponse } from "@/components/settings-bits";
import { useToast } from "@/components/toast";
import { Badge, Button, Callout, Card, CardHeader, Field, Input } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";

export type ServiceStatus = {
  firecrawl: { configured: boolean; url: string; tasks: number; dailyCredits: number; usage: { today: { calls: number; credits: number; byKind: Record<string, { calls: number; credits: number }> }; last30Days: { calls: number; credits: number } } };
  apify: { configured: boolean; maxChargeUsd: number; tasks: { id: string; name: string; actorId: string }[] };
};

type Ints = SettingsResponse["settings"]["integrations"] & { hasFirecrawlKey?: boolean; hasApifyToken?: boolean };

function KeyField({ label, saved, masked, value, onChange, placeholder, hint }: { label: string; saved: boolean; masked: string; value: string; onChange: (v: string) => void; placeholder: string; hint: string }) {
  return (
    <Field label={saved ? `${label} (saved ${masked})` : label} hint={saved ? "Type a new one to replace it." : hint}>
      {(p) => <Input {...p} type="password" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} placeholder={saved ? "••••••••" : placeholder} />}
    </Field>
  );
}

function useTest(path: string, name: string) {
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  const run = async () => {
    setTesting(true);
    try { const r = await api<{ message: string }>(path, { method: "POST" }); toast.success(`${name} works`, r.message); }
    catch (e) { toast.error(`${name} did not work`, errorText(e)); } finally { setTesting(false); }
  };
  return { testing, run };
}

export function FirecrawlTab({ data, status, onSaved }: { data: SettingsResponse; status: ServiceStatus; onSaved: (s: S) => void }) {
  const s = useSection(data.settings.integrations, "integrations", onSaved);
  const ints = data.settings.integrations as Ints;
  const [key, setKey] = useState("");
  const test = useTest("/api/integrations/firecrawl/test", "Firecrawl");
  const save = async () => { if (await s.save(key ? { firecrawlKey: key } : {})) setKey(""); };
  return (
    <div className="space-y-6">
      <Panel title="Firecrawl" icon={<Flame className="size-4 text-muted" />}
        description={<>Firecrawl loads pages in its own browsers and searches the web with your key. Scaper then reads the page with your selectors or <strong>your own AI model</strong>, so it works like a third fetch mode next to Fast and Browser. Each page costs Firecrawl credits.</>}
        footer={<>
          <Button variant="secondary" icon={<ShieldCheck className="size-4" />} loading={test.testing} disabled={!status.firecrawl.configured} onClick={() => void test.run()}>Test</Button>
          <Button icon={<Save className="size-4" />} loading={s.saving} onClick={() => void save()}>Save</Button>
        </>}>
        {status.firecrawl.configured && <Callout tone="success" icon={<CheckCircle2 className="size-4 text-success" />} title="Connected">Choose <strong>Firecrawl</strong> as the fetch mode in a task or quick scrape. The agent and your bots can also use web search and Firecrawl pages.{status.firecrawl.tasks ? ` ${status.firecrawl.tasks} task(s) use it.` : ""}</Callout>}
        <div className="grid gap-4 md:grid-cols-2">
          <KeyField label="API key" saved={Boolean(ints.hasFirecrawlKey)} masked={ints.firecrawlKey} value={key} onChange={setKey} placeholder="fc-…" hint="From firecrawl.dev → API keys. Stored only on this computer." />
          <Field label="Server" hint="Leave as is for firecrawl.dev, or point to your own Firecrawl server.">
            {(p) => <Input {...p} className="font-mono text-xs" value={s.v.firecrawlUrl} onChange={(e) => s.set({ firecrawlUrl: e.target.value })} />}
          </Field>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Daily credit limit" hint="Scaper stops using Firecrawl for the day at this many credits. 0 means no limit.">
            {(p) => <Input {...p} type="number" min={0} step={10} value={s.v.firecrawlDailyCredits} onChange={(e) => s.set({ firecrawlDailyCredits: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />}
          </Field>
          <div className="rounded-xl border border-border p-3 text-sm" aria-label="Firecrawl credits used">
            <p className="font-medium">Credits used by Scaper</p>
            <p className="mt-1 text-muted">Today <strong className="text-text tabular-nums">{status.firecrawl.usage.today.credits}</strong>{status.firecrawl.dailyCredits ? ` of ${status.firecrawl.dailyCredits}` : ""} in {status.firecrawl.usage.today.calls} call(s) · last 30 days <strong className="text-text tabular-nums">{status.firecrawl.usage.last30Days.credits}</strong></p>
            {Object.keys(status.firecrawl.usage.today.byKind).length > 0 && <p className="mt-1 text-xs text-muted">{Object.entries(status.firecrawl.usage.today.byKind).map(([k, v]) => `${k} ${v.calls}× (${v.credits})`).join(" · ")}</p>}
            <p className="mt-1 text-xs text-muted">Counted at Firecrawl&apos;s list prices; Test shows what your account really has left.</p>
          </div>
        </div>
        {ints.hasFirecrawlKey && <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => void s.save({ firecrawlKey: "" })}>Remove the key</Button>}
      </Panel>
      <Card>
        <CardHeader title="What it is used for" />
        <ul className="list-disc space-y-1.5 px-9 pb-5 text-sm text-muted">
          <li><strong className="text-text">Tasks and quick scrapes:</strong> fetch mode Firecrawl, for pages that Fast mode cannot read and your own browser is too slow for.</li>
          <li><strong className="text-text">AI agent and bots:</strong> <code>web_search</code> to find pages, <code>firecrawl_scrape</code> to read one, <code>firecrawl_map</code> to list a site&apos;s pages.</li>
          <li><strong className="text-text">Smart mode saves credits:</strong> Scaper loads the page for free first (Fast, then its own browser) and only asks Firecrawl when that fails or comes back empty. Your AI does the same: it finds file links with one <code>firecrawl_map</code> call (1 credit for a whole site) instead of opening every page.</li>
          <li><strong className="text-text">Same rules:</strong> Scaper still checks robots.txt and your site rules before each page, and never asks Firecrawl for stealth proxies.</li>
        </ul>
      </Card>
    </div>
  );
}

type Actor = { id: string; title: string; description: string; users: number | null; pricing: string | null };

export function ApifyTab({ data, status, onSaved }: { data: SettingsResponse; status: ServiceStatus; onSaved: (s: S) => void }) {
  const toast = useToast();
  const s = useSection(data.settings.integrations, "integrations", onSaved);
  const ints = data.settings.integrations as Ints;
  const [token, setToken] = useState("");
  const [q, setQ] = useState("");
  const [actors, setActors] = useState<Actor[] | null>(null);
  const [searching, setSearching] = useState(false);
  const test = useTest("/api/integrations/apify/test", "Apify");
  const save = async () => { if (await s.save(token ? { apifyToken: token } : {})) setToken(""); };
  const search = async () => {
    setSearching(true);
    try { setActors((await api<{ actors: Actor[] }>(`/api/integrations/apify/store?q=${encodeURIComponent(q.trim())}`)).actors); }
    catch (e) { toast.error("Could not search the Apify Store", errorText(e)); } finally { setSearching(false); }
  };
  return (
    <div className="space-y-6">
      <Panel title="Apify" icon={<KeyRound className="size-4 text-muted" />}
        description="Apify runs ready-made scrapers (actors) on your account: YouTube, Instagram, TikTok, X, Google Maps and thousands more. In Scaper an actor becomes a task's source, so its results get history, change alerts, AI columns, exports and downloads, and your AI agent and bots can run actors too."
        footer={<>
          <Button variant="secondary" icon={<ShieldCheck className="size-4" />} loading={test.testing} disabled={!status.apify.configured} onClick={() => void test.run()}>Test</Button>
          <Button icon={<Save className="size-4" />} loading={s.saving} onClick={() => void save()}>Save</Button>
        </>}>
        <div className="grid gap-4 md:grid-cols-2">
          <KeyField label="API token" saved={Boolean(ints.hasApifyToken)} masked={ints.apifyToken} value={token} onChange={setToken} placeholder="apify_api_…" hint="From console.apify.com → Settings → API & Integrations. Stored only on this computer." />
          <Field label="Cost cap for runs by the agent and bots (US$)" hint="Pay-per-result actors stop at this amount per run. Tasks have their own cap.">
            {(p) => <Input {...p} type="number" min={0} step={0.5} value={s.v.apifyMaxChargeUsd} onChange={(e) => s.set({ apifyMaxChargeUsd: Math.max(0, Number(e.target.value) || 0) })} />}
          </Field>
        </div>
        {ints.hasApifyToken && <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => void s.save({ apifyToken: "" })}>Remove the token</Button>}
      </Panel>
      {status.apify.configured && (
        <Panel title="Find an actor" icon={<Search className="size-4 text-muted" />} description="Search the Apify Store, then make a task from it: open Tasks → New task → Source → Apify actor, or pick one of the social media templates there.">
          <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (q.trim()) void search(); }}>
            <Input aria-label="Search the Apify Store" className="min-w-0 flex-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder="youtube, instagram hashtag, tiktok trending …" />
            <Button type="submit" variant="secondary" loading={searching} disabled={!q.trim()}>Search</Button>
          </form>
          {actors && (actors.length ? (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {actors.map((a) => (
                <li key={a.id} className="space-y-1 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{a.title}</span><code className="text-xs text-muted">{a.id}</code>
                    {a.pricing && <Badge>{a.pricing.toLowerCase().replace(/_/g, " ")}</Badge>}
                    {a.users !== null && <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted"><Users className="size-3" />{a.users.toLocaleString("en-IN")}</span>}
                  </div>
                  <p className="text-xs text-muted">{a.description}</p>
                  <Link prefetch={false} href={`/tasks/new?apify=${encodeURIComponent(a.id)}`} className="text-xs text-accent hover:underline">Make a task from it</Link>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">No actors found.</p>)}
        </Panel>
      )}
      {status.apify.tasks.length > 0 && (
        <Card>
          <CardHeader title="Tasks that run actors" />
          <ul className="divide-y divide-border">
            {status.apify.tasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-sm">
                <Link prefetch={false} href={`/tasks/${t.id}`} className="font-medium hover:text-accent">{t.name}</Link><code className="text-xs text-muted">{t.actorId}</code>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
