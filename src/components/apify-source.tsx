"use client";

import { useState } from "react";
import { Download, ExternalLink, Sparkles } from "lucide-react";
import type { TaskSource } from "@/lib/schemas";
import { api, errorText } from "@/lib/api-client";
import { useToast } from "./toast";
import { Badge, Button, Callout, Field, Input, Textarea } from "./ui";

type ApifySource = Extract<TaskSource, { type: "apify" }>;

/**
 * Ready-made starting points for social media and maps. Inputs follow each actor's Input tab (checked Oct 2026);
 * "Load the actor's example" fetches the current one from Apify if an actor changed its fields.
 */
export const APIFY_TEMPLATES: { key: string; label: string; emoji: string; actorId: string; input: Record<string, unknown>; keyFields: string[]; name: string; note: string }[] = [
  {
    key: "youtube", label: "YouTube: top videos for a search", emoji: "▶️", actorId: "streamers~youtube-scraper", name: "YouTube trending: tamil songs",
    input: { searchQueries: ["tamil songs"], maxResults: 20, maxResultsShorts: 0, maxResultStreams: 0, sortingOrder: "views", dateFilter: "week" },
    keyFields: ["url"], note: "Most viewed videos this week for each search. Change the searches, the date filter (hour, today, week, month, year) and the sort.",
  },
  {
    key: "instagram-hashtag", label: "Instagram: reels for a hashtag", emoji: "📸", actorId: "apify~instagram-hashtag-scraper", name: "Instagram #chennai reels",
    input: { hashtags: ["chennai"], resultsType: "reels", resultsLimit: 20 }, keyFields: ["url"],
    note: "Public posts or reels for each hashtag (resultsType: posts, reels or stories).",
  },
  {
    key: "instagram-profile", label: "Instagram: a profile's latest posts", emoji: "👤", actorId: "apify~instagram-scraper", name: "Instagram profile posts",
    input: { directUrls: ["https://www.instagram.com/natgeo/"], resultsType: "posts", resultsLimit: 20 }, keyFields: ["url"],
    note: "Public posts of the profiles you list in directUrls.",
  },
  {
    key: "tiktok", label: "TikTok: videos for a hashtag", emoji: "🎵", actorId: "clockworks~tiktok-scraper", name: "TikTok #trending",
    input: { hashtags: ["trending"], resultsPerPage: 20, shouldDownloadVideos: false, shouldDownloadCovers: false }, keyFields: ["webVideoUrl"],
    note: "Public videos for each hashtag. You can also use profiles or searchQueries.",
  },
  {
    key: "x", label: "X (Twitter): posts for a search", emoji: "𝕏", actorId: "apidojo~tweet-scraper", name: "X posts: #AI",
    input: { searchTerms: ["#AI"], maxItems: 50, sort: "Latest" }, keyFields: ["url"],
    note: "Check the input with \"Load the actor's example\" first; this actor changes its fields from time to time.",
  },
  {
    key: "maps", label: "Google Maps: places for a search", emoji: "📍", actorId: "compass~crawler-google-places", name: "Google Maps: restaurants in Chennai",
    input: { searchStringsArray: ["restaurants in Chennai"], maxCrawledPlacesPerSearch: 20, language: "en" }, keyFields: ["placeId"],
    note: "Name, rating, reviews count, address, phone and website of each place.",
  },
];

export const actorPage = (id: string) => `https://apify.com/${id.replace("~", "/")}`;

export function ApifySourceEditor({ value, onChange, configured, onTemplate, error }: {
  value: ApifySource; onChange: (v: ApifySource) => void; configured: boolean;
  onTemplate: (t: (typeof APIFY_TEMPLATES)[number]) => void; error?: string;
}) {
  const toast = useToast();
  const [text, setText] = useState(() => JSON.stringify(value.input, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // A template or a loaded example replaces the input from outside; show it in the box.
  const [lastInput, setLastInput] = useState(value.input);
  if (lastInput !== value.input && JSON.stringify(lastInput) !== JSON.stringify(value.input)) { setLastInput(value.input); setText(JSON.stringify(value.input, null, 2)); setJsonError(null); }

  const editJson = (t: string) => {
    setText(t);
    try {
      const v = JSON.parse(t || "{}") as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("The input must be a JSON object: { … }");
      setJsonError(null);
      setLastInput(v as Record<string, unknown>);
      onChange({ ...value, input: v as Record<string, unknown> });
    } catch (e) { setJsonError((e as Error).message); }
  };
  const loadExample = async () => {
    setLoading(true);
    try {
      const a = await api<{ id: string; title: string; example: Record<string, unknown> }>(`/api/integrations/apify/actor?id=${encodeURIComponent(value.actorId)}`);
      onChange({ ...value, actorId: a.id, input: a.example });
      toast.success(`Loaded ${a.title}`, Object.keys(a.example).length ? "Its example input is in the box; change it as you need." : "This actor has no example input. See its Input tab on Apify.");
    } catch (e) { toast.error("Could not load the actor", errorText(e)); } finally { setLoading(false); }
  };

  return (
    <div className="space-y-4">
      {!configured && <Callout tone="warning" title="Add your Apify token first">Open <a className="text-accent hover:underline" href="/integrations?tab=apify">Integrations → Apify</a> and paste your API token. You can set the task up now and run it once the token is saved.</Callout>}
      <div>
        <p className="mb-2 text-sm font-medium">Start from a template</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {APIFY_TEMPLATES.map((t) => (
            <button key={t.key} type="button" onClick={() => onTemplate(t)}
              className={`rounded-xl border p-3 text-left text-sm transition-colors hover:border-accent ${value.actorId === t.actorId ? "border-accent bg-accent-soft/40" : "border-border"}`}>
              <span className="font-medium">{t.emoji} {t.label}</span>
              <span className="mt-0.5 block text-xs text-muted">{t.note}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <Field label="Actor" error={error} hint="From the actor's page on Apify, like apify~instagram-scraper (apify.com/apify/instagram-scraper works too).">
          {(p) => <Input {...p} className="font-mono text-xs" value={value.actorId} onChange={(e) => onChange({ ...value, actorId: e.target.value.trim() })} placeholder="username~actor-name" />}
        </Field>
        <div className="flex gap-2">
          <Button variant="secondary" icon={<Sparkles className="size-4" />} loading={loading} disabled={!configured || value.actorId.length < 3} onClick={() => void loadExample()}>Load the actor&apos;s example</Button>
          {value.actorId.includes("~") && <a href={actorPage(value.actorId)} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm text-accent hover:underline"><ExternalLink className="size-4" />Apify</a>}
        </div>
      </div>
      <Field label="Actor input (JSON)" error={jsonError ?? undefined} hint="The same JSON as the actor's Input tab on Apify (choose the JSON view there).">
        {(p) => <Textarea {...p} rows={9} spellCheck={false} className="font-mono text-xs" value={text} onChange={(e) => editJson(e.target.value)} />}
      </Field>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Items per run" hint="Apify stops the actor here.">{(p) => <Input {...p} type="number" min={1} max={100000} value={value.maxItems} onChange={(e) => onChange({ ...value, maxItems: Math.max(1, Math.round(Number(e.target.value) || 1)) })} />}</Field>
        <Field label="Cost cap per run (US$)" hint="For pay-per-result actors. 0 = the actor's own limit.">{(p) => <Input {...p} type="number" min={0} step={0.5} value={value.maxChargeUsd} onChange={(e) => onChange({ ...value, maxChargeUsd: Math.max(0, Number(e.target.value) || 0) })} />}</Field>
        <Field label="Time limit (seconds)">{(p) => <Input {...p} type="number" min={30} max={86400} value={value.timeoutSeconds} onChange={(e) => onChange({ ...value, timeoutSeconds: Math.max(30, Math.round(Number(e.target.value) || 30)) })} />}</Field>
      </div>
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge tone="accent">your account</Badge> The actor runs on Apify and its results become this task&apos;s rows: history, new-item alerts, AI columns, exports and <Download className="inline size-3" /> downloads all work. Public data only; respect each platform&apos;s rules and creators&apos; rights.
      </p>
    </div>
  );
}
