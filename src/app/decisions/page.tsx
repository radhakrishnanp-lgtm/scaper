"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Ban, Braces, CheckCircle2, CircleHelp, FlaskConical, Link2, ListChecks, Play, Plus, RotateCcw, Scale, ShieldCheck, Trash2, XCircle } from "lucide-react";
import type { CheckOutcome, DecisionAnswerShape, DecisionQuestionShape, Finding, ReadOutcome } from "@/lib/decision-policy";
import { CopyButton } from "@/components/data-table";
import { Badge, Button, Callout, Card, CardHeader, EmptyState, ErrorNote, Field, IconButton, Input, PageHeader, Segmented, Select, Stat, Tabs, Textarea } from "@/components/ui";
import { api, ClientApiError, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { useApi } from "@/lib/use-api";
import { useQueryState } from "@/lib/use-query-state";

type Tab = "check" | "links" | "playground";
type Status = {
  enabled: boolean; ready: boolean; model: string; provider: { id: string; name: string } | null; endpoint: string | null;
  uses: { pickLinks: boolean; scrapeCheck: boolean; agentGuard: boolean }; linkThreshold: number; riskThreshold: number;
};
type AiMeta = { model: string; latencyMs: number; cost: number; id: string };
type ScrapeCheck = {
  url: string; finalUrl: string | null; title: string | null; status: number | null; outcome: CheckOutcome; findings: Finding[];
  kind: { value: string; p: number; label: string } | null; richness: { score: number; label: string } | null;
  ai: AiMeta | { error: string } | null; checkedAt: string;
};
type LinkResult = { page: { url: string; title: string }; threshold: number; startIsListing: number | null; ai: AiMeta; skipped: number; links: { text: string; url: string; area: string; p: number }[] };
type RunResult = {
  result: { id: string; requestId: string; model: string; provider: string | null; answers: Record<string, DecisionAnswerShape>; usage: { inputTokens: number; outputTokens: number; cost: number }; latencyMs: number };
  read: ReadOutcome; threshold: number;
};

const pct = (p: number) => `${Math.round(p * 100)}%`;
const money = (v: number) => (v >= 0.01 ? `$${v.toFixed(2)}` : v > 0 ? `$${v.toFixed(5)}` : "$0");
const pathOf = (u: string) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };

/** A thin horizontal meter for one probability, with an optional threshold tick. */
function Meter({ p, threshold, label, tone = "accent" }: { p: number; threshold?: number; label: string; tone?: "accent" | "muted" }) {
  return (
    <div className="relative h-2 w-full rounded-full bg-surface-2" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)}>
      <div className={cn("h-2 rounded-full", tone === "accent" ? "bg-accent" : "bg-muted/50")} style={{ width: `${Math.max(1, p * 100)}%` }} />
      {threshold !== undefined && <div className="absolute -top-1 h-4 w-0.5 rounded bg-text/70" style={{ left: `calc(${threshold * 100}% - 1px)` }} title={`Threshold ${pct(threshold)}`} />}
    </div>
  );
}

const OUTCOME: Record<CheckOutcome, { label: string; tone: "success" | "warning" | "danger"; icon: React.ReactNode; text: string }> = {
  ok: { label: "OK to scrape", tone: "success", icon: <CheckCircle2 className="size-5 text-success" />, text: "Nothing says this page is off-limits. Keep Scaper's polite delays on." },
  caution: { label: "Scrape with care", tone: "warning", icon: <AlertTriangle className="size-5 text-warning" />, text: "It can be scraped, but read the points below first." },
  stop: { label: "Don't scrape this", tone: "danger", icon: <Ban className="size-5 text-danger" />, text: "A hard rule says no. Scaper will not work around it." },
};
const LEVEL_ICON: Record<Finding["level"], React.ReactNode> = {
  stop: <XCircle className="size-4 shrink-0 text-danger" aria-label="Stop" />,
  caution: <AlertTriangle className="size-4 shrink-0 text-warning" aria-label="Caution" />,
  ok: <CheckCircle2 className="size-4 shrink-0 text-success" aria-label="OK" />,
  info: <CircleHelp className="size-4 shrink-0 text-muted" aria-label="Note" />,
};

function ModeAndGo({ busy, onGo, label, disabled }: { busy: boolean; onGo: () => void; label: string; disabled?: boolean }) {
  return <Button icon={<Play className="size-4" />} loading={busy} disabled={disabled} onClick={onGo}>{label}</Button>;
}

// ---------------------------------------------------------------------------------------------

function CheckTab({ status, initialUrl, onPickLinks }: { status: Status; initialUrl: string; onPickLinks: (url: string, goal: string) => void }) {
  const [url, setUrl] = useState(initialUrl);
  const [goal, setGoal] = useState("");
  const [mode, setMode] = useState<"fast" | "browser">("fast");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<ScrapeCheck | null>(null);
  const run = async () => {
    setBusy(true); setError(null); setCheck(null);
    try { setCheck((await api<{ check: ScrapeCheck }>("/api/decisions/check", { body: { url: url.trim(), goal: goal.trim() || undefined, mode } })).check); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  const o = check ? OUTCOME[check.outcome] : null;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      <Card>
        <CardHeader title="Is this page OK to scrape?" description="robots.txt and the page's own signals first, then your decision model reads the page." />
        <form className="space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); void run(); }}>
          <Field label="Page address">{(f) => <Input {...f} type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.example.com/laptops" />}</Field>
          <Field label="What you want from it (optional)" hint="Adds the question: does this page have it?">{(f) => <Input {...f} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="laptops with price and rating" />}</Field>
          <div>
            <p className="mb-1.5 text-sm font-medium">Load the page with</p>
            <Segmented label="Load with" value={mode} onChange={setMode} options={[{ value: "fast", label: "Fast (HTTP)" }, { value: "browser", label: "Browser" }]} />
          </div>
          {!status.ready && <p className="text-xs text-muted">The decision model is off, so only the rules run. <Link prefetch={false} href="/settings?tab=ai" className="text-accent hover:underline">Set it up</Link></p>}
          <ModeAndGo busy={busy} onGo={() => void run()} label="Check" disabled={!url.trim()} />
        </form>
      </Card>
      <div className="min-w-0 space-y-4">
        {error && <Card><ErrorNote title="The check did not finish" message={error} onRetry={() => void run()} /></Card>}
        {!check && !error && !busy && <EmptyState icon={<ShieldCheck className="size-5" />} title="Run a check to see the answer">Scaper loads the page politely, as it would for a task, and tells you whether it is fine, needs care, or is off-limits, and why.</EmptyState>}
        {busy && <div className="skeleton h-48 rounded-xl" />}
        {check && o && (
          <>
            <Card className="p-5">
              <div className="flex items-start gap-3">
                {o.icon}
                <div className="min-w-0 flex-1">
                  <p className="text-lg font-semibold">{o.label}</p>
                  <p className="text-sm text-muted">{o.text}</p>
                  <p className="mt-1 truncate text-xs text-muted" title={check.finalUrl ?? check.url}>{check.title ? `${check.title} · ` : ""}{check.finalUrl ?? check.url}</p>
                </div>
                <Badge tone={o.tone}>{check.outcome}</Badge>
              </div>
              <ul className="mt-4 space-y-2">
                {check.findings.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    {LEVEL_ICON[f.level]}
                    <span className="min-w-0 flex-1">{f.text}</span>
                    <Badge tone={f.source === "ai" ? "accent" : "neutral"}>{f.source === "ai" ? "decision model" : "rule"}</Badge>
                  </li>
                ))}
              </ul>
              {check.outcome !== "stop" && check.finalUrl && (
                <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
                  <Link prefetch={false} href={`/scrape?url=${encodeURIComponent(check.finalUrl)}`}><Button size="sm">Scrape this page</Button></Link>
                  <Button size="sm" variant="secondary" icon={<Link2 className="size-4" />} onClick={() => onPickLinks(check.finalUrl!, goal)}>Find what to scrape on it</Button>
                </div>
              )}
            </Card>
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label="Page kind" value={check.kind ? check.kind.label : "–"} hint={check.kind ? `${pct(check.kind.p)} sure` : "Needs the decision model"} />
              <Stat label="Data on it" value={check.richness ? check.richness.label : "–"} hint={check.richness ? `score ${check.richness.score.toFixed(2)} of 2` : undefined} />
              <Stat label="Decision model" value={check.ai && "model" in check.ai ? `${(check.ai.latencyMs / 1000).toFixed(2)}s` : check.ai ? "failed" : "off"} hint={check.ai && "model" in check.ai ? `${check.ai.model} · ${money(check.ai.cost)}` : check.ai && "error" in check.ai ? check.ai.error : "rules only"} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function LinksTab({ status, initial }: { status: Status; initial: { url: string; goal: string; key: number } }) {
  const [url, setUrl] = useState(initial.url);
  const [goal, setGoal] = useState(initial.goal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<LinkResult | null>(null);
  const [cut, setCut] = useState(status.linkThreshold);
  const [showAll, setShowAll] = useState(false);
  const run = async () => {
    setBusy(true); setError(null); setRes(null);
    try { const r = await api<LinkResult>("/api/decisions/links", { body: { url: url.trim(), goal: goal.trim() } }); setRes(r); setCut(r.threshold); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  const picked = res?.links.filter((l) => l.p >= cut) ?? [];
  const shown = res ? (showAll ? res.links : res.links.slice(0, 40)) : [];
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Find what to scrape" description="Your decision model reads every link on a page and says how likely each one leads to what you want. One request for all of them." />
        <form className="grid gap-4 p-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end" onSubmit={(e) => { e.preventDefault(); void run(); }}>
          <Field label="Start page">{(f) => <Input {...f} type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.example.com/" />}</Field>
          <Field label="What you want">{(f) => <Input {...f} required value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="laptops and tablets" />}</Field>
          <ModeAndGo busy={busy} onGo={() => void run()} label="Score links" disabled={!url.trim() || goal.trim().length < 2 || !status.provider} />
        </form>
        {!status.provider && <p className="px-5 pb-5 text-sm text-muted">Add OpenRouter as a provider and set up the decision model in <Link prefetch={false} href="/settings?tab=ai" className="text-accent hover:underline">Settings → AI</Link> first.</p>}
      </Card>
      {error && <Card><ErrorNote title="Could not score the links" message={error} onRetry={() => void run()} /></Card>}
      {busy && <div className="skeleton h-64 rounded-xl" />}
      {res && (
        <Card>
          <CardHeader
            title={`${picked.length} of ${res.links.length} links match`}
            description={<>{res.page.title || res.page.url}{res.startIsListing !== null && ` · the start page itself lists items: ${pct(res.startIsListing)}`}{res.skipped ? ` · ${res.skipped} more links were not asked` : ""} · {(res.ai.latencyMs / 1000).toFixed(2)}s, {money(res.ai.cost)}</>}
            actions={<div className="flex flex-wrap gap-2">
              <CopyButton text={picked.map((l) => l.url).join("\n")} label="Copy matching URLs" />
              <Link prefetch={false} href={`/crawl?url=${encodeURIComponent(res.page.url)}&goal=${encodeURIComponent(goal)}`}><Button size="sm" variant="secondary">Category scrape</Button></Link>
            </div>}
          />
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
            <label htmlFor="cut" className="text-sm">Match from <span className="font-medium tabular-nums">{pct(cut)}</span></label>
            <input id="cut" type="range" min={0.1} max={0.95} step={0.05} value={cut} onChange={(e) => setCut(Number(e.target.value))} className="w-48 accent-[var(--accent)]" />
            <span className="text-xs text-muted">Only changes this view. The default is in Settings → AI.</span>
          </div>
          <ul className="divide-y divide-border">
            {shown.map((l) => (
              <li key={l.url} className={cn("grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-3 px-5 py-2.5 sm:grid-cols-[3rem_minmax(0,1fr)_10rem]", l.p < cut && "opacity-60")}>
                <span className="text-right text-sm font-medium tabular-nums">{pct(l.p)}</span>
                <div className="min-w-0">
                  <p className="flex items-center gap-2 truncate text-sm">{l.p >= cut ? <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-label="Match" /> : <span className="size-3.5 shrink-0" />}{l.text}<Badge>{l.area}</Badge></p>
                  <a href={l.url} target="_blank" rel="noreferrer" className="block truncate font-mono text-xs text-muted hover:text-accent">{pathOf(l.url)}</a>
                </div>
                <div className="hidden sm:block"><Meter p={l.p} threshold={cut} label={`${l.text}: ${pct(l.p)}`} tone={l.p >= cut ? "accent" : "muted"} /></div>
              </li>
            ))}
          </ul>
          {res.links.length > 40 && <div className="border-t border-border p-3 text-center"><Button size="sm" variant="ghost" onClick={() => setShowAll((x) => !x)}>{showAll ? "Show the top 40" : `Show all ${res.links.length}`}</Button></div>}
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Playground

type Recipe = { id: string; label: string; state: string; questions: Record<string, DecisionQuestionShape>; threshold: number };

const RECIPES: Recipe[] = [
  {
    id: "scrape", label: "OK to scrape?", threshold: 0.7,
    state: JSON.stringify({ page: { url: "https://shop.example.com/account/orders", title: "Your orders", text: "Hello Priya. Order #40211 shipped to 14 Lake Road, Chennai. Phone +91 98xxxxxx12. Track package." } }, null, 2),
    questions: {
      personal_data: { type: "noul", instructions: "Does state.page show personal details of private individuals?", criteria: { true: "Names with phone numbers, emails, home addresses or IDs of private people.", false: "No personal details of private people." } },
      page_kind: { type: "choice", instructions: "What kind of page is state.page?", criteria: { listing: "Lists many items", detail: "One item", account_area: "A signed-in user's account area", other: "None of these" } },
    },
  },
  {
    id: "links", label: "Which link?", threshold: 0.6,
    state: JSON.stringify({ goal: "laptops with prices", links: [{ n: 1, text: "Laptops", path: "/c/laptops" }, { n: 2, text: "Track order", path: "/orders" }, { n: 3, text: "Gaming notebooks", path: "/c/gaming" }] }, null, 2),
    questions: {
      link_1: { type: "noul", instructions: "Does link 1 in state.links lead to a listing of what state.goal asks for?" },
      link_2: { type: "noul", instructions: "Does link 2 in state.links lead to a listing of what state.goal asks for?" },
      link_3: { type: "noul", instructions: "Does link 3 in state.links lead to a listing of what state.goal asks for?" },
    },
  },
  {
    id: "guard", label: "Agent guardrail", threshold: 0.8,
    state: JSON.stringify({ user_request: "Pause my laptop price watcher for a week.", proposed_action: { tool: "delete_watcher", summary: "Delete watcher \"Laptop prices\" and its history." } }, null, 2),
    questions: {
      matches_request: { type: "noul", instructions: "Does state.proposed_action directly serve state.user_request?", criteria: { true: "It is what the user asked for.", false: "It goes beyond or against the request." } },
      reversible: { type: "noul", instructions: "Can the action be undone easily?", criteria: { true: "Yes.", false: "No, it deletes data or sends a message." } },
      needs_review: { type: "noul", instructions: "Should a person confirm this before it runs?" },
    },
  },
  {
    id: "quality", label: "Data quality", threshold: 0.7,
    state: JSON.stringify({ rows: [{ name: "Lenovo IdeaPad 5", price: "₹61,990", rating: "4.3" }, { name: "Add to cart", price: "", rating: "" }, { name: "HP Pavilion 14", price: "₹58,499", rating: "4.1" }] }, null, 2),
    questions: {
      looks_right: { type: "score", instructions: "How clean are state.rows as a product list?", criteria: ["Mostly junk", "Some junk rows", "Clean"] },
      has_junk_rows: { type: "noul", instructions: "Do any rows in state.rows look like buttons or page chrome instead of products?" },
    },
  },
  {
    id: "routing", label: "Support routing", threshold: 0.7,
    state: "Customer message: My payouts have failed for three days and payroll is due today.",
    questions: {
      is_urgent: { type: "noul", instructions: "Does the message describe an urgent problem?", criteria: { true: "A deadline or an active blockage is stated.", false: "No urgency is stated." } },
      team: { type: "choice", instructions: "Which team should handle it?", criteria: { billing: "Payments, payouts, invoices", technical: "Bugs and outages", account: "Login and access", other: "None of these" } },
    },
  },
];

type Draft = { state: string; questions: { name: string; q: DecisionQuestionShape }[]; threshold: number };
const toDraft = (r: Recipe): Draft => ({ state: r.state, questions: Object.entries(r.questions).map(([name, q]) => ({ name, q })), threshold: r.threshold });
const parseState = (s: string): unknown => { const t = s.trim(); if (/^[[{]/.test(t)) { try { return JSON.parse(t); } catch { return t; } } return t; };
const toBody = (d: Draft) => ({ state: parseState(d.state), questions: Object.fromEntries(d.questions.map((x) => [x.name, x.q])), threshold: d.threshold });

function QuestionEditor({ name, q, errors, onChange, onRename, onRemove }: {
  name: string; q: DecisionQuestionShape; errors: Record<string, string>; onChange: (q: DecisionQuestionShape) => void; onRename: (n: string) => void; onRemove: () => void;
}) {
  const setType = (type: DecisionQuestionShape["type"]) => {
    if (type === q.type) return;
    onChange(type === "noul" ? { type, instructions: q.instructions } : type === "choice" ? { type, instructions: q.instructions, criteria: { yes: "", no: "", other: "None of these" } } : { type, instructions: q.instructions, criteria: ["Low", "Medium", "High"] });
  };
  const err = (k: string) => errors[`questions.${name}.${k}`];
  return (
    <div className="space-y-3 rounded-xl border border-border p-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end">
        <Field label="Name" error={errors[`questions.${name}`]}>{(f) => <Input {...f} className="font-mono text-xs" value={name} onChange={(e) => onRename(e.target.value.replace(/[^\w-]/g, "_"))} />}</Field>
        <Field label="Type">{(f) => (
          <Select {...f} value={q.type} onChange={(e) => setType(e.target.value as DecisionQuestionShape["type"])}>
            <option value="noul">Yes / no</option><option value="choice">Pick one</option><option value="score">Rate on a scale</option>
          </Select>
        )}</Field>
        <IconButton label={`Remove ${name}`} onClick={onRemove}><Trash2 className="size-4" /></IconButton>
      </div>
      <Field label="Question" error={err("instructions")}>{(f) => <Textarea {...f} rows={2} value={q.instructions} onChange={(e) => onChange({ ...q, instructions: e.target.value })} />}</Field>
      {q.type === "noul" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Yes means (optional)">{(f) => <Input {...f} value={q.criteria?.true ?? ""} onChange={(e) => onChange({ ...q, criteria: e.target.value || q.criteria?.false ? { true: e.target.value, false: q.criteria?.false ?? "" } : undefined })} />}</Field>
          <Field label="No means (optional)" error={err("criteria.true") ?? err("criteria.false")}>{(f) => <Input {...f} value={q.criteria?.false ?? ""} onChange={(e) => onChange({ ...q, criteria: e.target.value || q.criteria?.true ? { true: q.criteria?.true ?? "", false: e.target.value } : undefined })} />}</Field>
        </div>
      )}
      {q.type === "choice" && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Options</p>
          {Object.entries(q.criteria).map(([opt, desc], i) => (
            <div key={i} className="grid grid-cols-[8rem_minmax(0,1fr)_auto] gap-2">
              <Input aria-label={`Option ${i + 1} name`} className="font-mono text-xs" value={opt} onChange={(e) => onChange({ ...q, criteria: Object.fromEntries(Object.entries(q.criteria).map(([k, v]) => (k === opt ? [e.target.value.replace(/[^\w-]/g, "_"), v] : [k, v]))) })} />
              <Input aria-label={`Option ${i + 1} meaning`} value={desc ?? ""} onChange={(e) => onChange({ ...q, criteria: { ...q.criteria, [opt]: e.target.value || null } })} placeholder="What it means" />
              <IconButton label={`Remove option ${opt}`} onClick={() => onChange({ ...q, criteria: Object.fromEntries(Object.entries(q.criteria).filter(([k]) => k !== opt)) })}><Trash2 className="size-4" /></IconButton>
            </div>
          ))}
          {err("criteria") && <p className="text-xs text-danger">{err("criteria")}</p>}
          <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => onChange({ ...q, criteria: { ...q.criteria, [`option_${Object.keys(q.criteria).length + 1}`]: null } })}>Add option</Button>
          <p className="text-xs text-muted">Keep a catch-all such as &quot;other&quot; so the model is never forced into a wrong answer.</p>
        </div>
      )}
      {q.type === "score" && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Levels, lowest first</p>
          {q.criteria.map((lvl, i) => (
            <div key={i} className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-2">
              <span className="text-xs text-muted tabular-nums">{i}</span>
              <Input aria-label={`Level ${i}`} value={lvl} onChange={(e) => onChange({ ...q, criteria: q.criteria.map((x, k) => (k === i ? e.target.value : x)) })} />
              <IconButton label={`Remove level ${i}`} disabled={q.criteria.length <= 2} onClick={() => onChange({ ...q, criteria: q.criteria.filter((_, k) => k !== i) })}><Trash2 className="size-4" /></IconButton>
            </div>
          ))}
          <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => onChange({ ...q, criteria: [...q.criteria, ""] })}>Add level</Button>
        </div>
      )}
    </div>
  );
}

function AnswerCard({ name, q, a, line, threshold }: { name: string; q: DecisionQuestionShape; a: DecisionAnswerShape | undefined; line: ReadOutcome["lines"][number] | undefined; threshold: number }) {
  const verdictIcon = !line?.sure ? <CircleHelp className="size-4 text-warning" aria-hidden /> : line.verdict === "no" ? <XCircle className="size-4 text-muted" aria-hidden /> : <CheckCircle2 className="size-4 text-success" aria-hidden />;
  const dist = a && a.type !== "noul" ? Object.entries(a.probabilities).sort((x, y) => (a.type === "score" ? Number(x[0]) - Number(y[0]) : y[1] - x[1])) : [];
  const levelName = (k: string) => (q.type === "score" ? q.criteria[Number(k)] ?? k : k);
  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-medium">{name}</span>
        <Badge>{q.type === "noul" ? "yes / no" : q.type === "choice" ? "pick one" : "scale"}</Badge>
        <span className="ml-auto flex items-center gap-1.5 text-sm font-medium">{verdictIcon}{line?.sure ? line.verdict : `unsure${line && line.verdict !== "unsure" && line.verdict !== "no answer" ? ` (${line.verdict})` : ""}`}</span>
      </div>
      {!a ? <p className="mt-2 text-sm text-muted">Not answered.</p> : a.type === "noul" ? (
        <div className="mt-3 space-y-1.5">
          <div className="flex justify-between text-xs text-muted"><span>Probability of yes</span><span className="font-medium text-text tabular-nums">{pct(a.noul)}</span></div>
          <Meter p={a.noul} threshold={threshold} label={`${name}: ${pct(a.noul)} yes`} />
        </div>
      ) : (
        <div className="mt-3 space-y-1.5">
          {dist.map(([k, p]) => (
            <div key={k} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_3rem] items-center gap-2 text-xs">
              <span className={cn("truncate", (a.type === "choice" ? k === a.choice : false) && "font-medium")} title={levelName(k)}>{levelName(k)}</span>
              <Meter p={p} threshold={threshold} label={`${levelName(k)}: ${pct(p)}`} tone={a.type === "choice" && k === a.choice ? "accent" : a.type === "score" ? "accent" : "muted"} />
              <span className="text-right tabular-nums">{pct(p)}</span>
            </div>
          ))}
          {a.type === "score" && <p className="text-xs text-muted">Expected position {a.score.toFixed(2)} of {Math.max(0, q.type === "score" ? q.criteria.length - 1 : 0)}{a.confidence !== null ? ` · confidence ${pct(Math.max(0, Math.min(1, a.confidence)))}` : ""}</p>}
          {a.type === "choice" && a.confidence !== null && <p className="text-xs text-muted">Confidence {pct(Math.max(0, Math.min(1, a.confidence)))}</p>}
        </div>
      )}
      {line && <p className="mt-2 text-xs text-muted">{line.detail}</p>}
    </div>
  );
}

function PlaygroundTab({ status }: { status: Status }) {
  const [recipe, setRecipe] = useState(RECIPES[0]!.id);
  const [draft, setDraft] = useState<Draft>(() => toDraft(RECIPES[0]!));
  const [mode, setMode] = useState<"form" | "json">("form");
  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [res, setRes] = useState<RunResult | null>(null);
  const [view, setView] = useState<"answers" | "raw">("answers");

  const load = (id: string) => { const r = RECIPES.find((x) => x.id === id)!; setRecipe(id); setDraft(toDraft(r)); setRes(null); setError(null); setFields({}); if (mode === "json") setJson(JSON.stringify(toBody(toDraft(r)), null, 2)); };
  const switchMode = (m: "form" | "json") => {
    if (m === "json") { setJson(JSON.stringify(toBody(draft), null, 2)); setJsonError(null); setMode(m); return; }
    try {
      const b = JSON.parse(json) as { state: unknown; questions: Record<string, DecisionQuestionShape>; threshold?: number };
      if (!b || typeof b !== "object" || !b.questions || typeof b.questions !== "object") throw new Error("Needs an object with state and questions.");
      setDraft({ state: typeof b.state === "string" ? b.state : JSON.stringify(b.state, null, 2), questions: Object.entries(b.questions).map(([name, q]) => ({ name, q })), threshold: b.threshold ?? draft.threshold });
      setJsonError(null); setMode(m);
    } catch (e) { setJsonError(`Fix the JSON first: ${(e as Error).message}`); }
  };
  const body = useMemo(() => {
    if (mode === "form") return toBody(draft);
    try { return JSON.parse(json) as ReturnType<typeof toBody>; } catch { return null; }
  }, [mode, draft, json]);
  const run = async () => {
    if (!body) { setJsonError("The JSON is not valid."); return; }
    setBusy(true); setError(null); setFields({}); setRes(null);
    try { setRes(await api<RunResult>("/api/decisions", { body: { ...body, threshold: draft.threshold } })); setView("answers"); }
    catch (e) { setError(errorText(e)); if (e instanceof ClientApiError && e.fields) setFields(e.fields); }
    finally { setBusy(false); }
  };
  const sentQuestions = (body?.questions ?? {}) as Record<string, DecisionQuestionShape>;
  const updateQ = (i: number, patch: Partial<{ name: string; q: DecisionQuestionShape }>) => setDraft((d) => ({ ...d, questions: d.questions.map((x, k) => (k === i ? { ...x, ...patch } : x)) }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Recipes">
        {RECIPES.map((r) => (
          <button key={r.id} type="button" aria-pressed={recipe === r.id} onClick={() => load(r.id)}
            className={cn("rounded-full border px-3 py-1.5 text-sm transition-colors", recipe === r.id ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:text-text")}>{r.label}</button>
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Input" description="State is the evidence; questions are what you ask about it. Text in the state is treated as data, never as instructions."
            actions={<Segmented label="Edit as" value={mode} onChange={switchMode} options={[{ value: "form", label: "Form" }, { value: "json", label: "JSON", icon: <Braces className="size-3.5" /> }]} />} />
          <div className="space-y-4 p-5">
            {jsonError && <Callout tone="danger" title="JSON problem">{jsonError}</Callout>}
            {mode === "json" ? (
              <Field label="Request JSON" hint="{ state, questions } as sent to the model. Up to 200 questions.">{(f) => <Textarea {...f} rows={22} className="font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />}</Field>
            ) : (
              <>
                <Field label="State" hint="Plain text, or JSON with named fields (recommended)." error={fields.state}>{(f) => <Textarea {...f} rows={8} className="font-mono text-xs" value={draft.state} onChange={(e) => setDraft({ ...draft, state: e.target.value })} spellCheck={false} />}</Field>
                <div className="space-y-3">
                  {draft.questions.map((x, i) => (
                    <QuestionEditor key={i} name={x.name} q={x.q} errors={fields} onChange={(q) => updateQ(i, { q })} onRename={(name) => updateQ(i, { name })} onRemove={() => setDraft({ ...draft, questions: draft.questions.filter((_, k) => k !== i) })} />
                  ))}
                  {fields.questions && <p className="text-xs text-danger">{fields.questions}</p>}
                  <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} disabled={draft.questions.length >= 200} onClick={() => setDraft({ ...draft, questions: [...draft.questions, { name: `question_${draft.questions.length + 1}`, q: { type: "noul", instructions: "" } }] })}>Add question</Button>
                </div>
              </>
            )}
            <div className="rounded-xl border border-border p-4">
              <label htmlFor="threshold" className="flex justify-between text-sm font-medium"><span>Threshold</span><span className="tabular-nums">{pct(draft.threshold)}</span></label>
              <input id="threshold" type="range" min={0.5} max={0.99} step={0.01} value={draft.threshold} onChange={(e) => setDraft({ ...draft, threshold: Number(e.target.value) })} className="mt-2 w-full accent-[var(--accent)]" />
              <p className="mt-1 text-xs text-muted">Scaper&apos;s rule, not the model&apos;s: a yes/no counts as yes at {pct(draft.threshold)} or more and as no at {pct(1 - draft.threshold)} or less; a pick-one or scale answer counts only when its top option reaches {pct(draft.threshold)}. Everything else is &quot;unsure&quot; and goes to a person.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button icon={<Play className="size-4" />} loading={busy} disabled={!status.provider} onClick={() => void run()}>Run decision</Button>
              <Button variant="secondary" icon={<RotateCcw className="size-4" />} onClick={() => load(recipe)}>Reset</Button>
            </div>
            {!status.provider && <p className="text-xs text-muted">Add OpenRouter as a provider in <Link prefetch={false} href="/settings?tab=ai" className="text-accent hover:underline">Settings → AI</Link> to run decisions.</p>}
          </div>
        </Card>
        <Card>
          <CardHeader title="Result" description={res ? `${res.result.model}${res.result.provider ? ` via ${res.result.provider}` : ""}` : status.endpoint ?? undefined}
            actions={res ? <Segmented label="Show" value={view} onChange={setView} options={[{ value: "answers", label: "Answers" }, { value: "raw", label: "JSON" }]} /> : undefined} />
          <div className="space-y-4 p-5">
            {busy && <div className="skeleton h-48 rounded-xl" />}
            {error && <ErrorNote title="The decision failed" message={error} onRetry={() => void run()} />}
            {!busy && !error && !res && <EmptyState icon={<Scale className="size-5" />} title="Run the decision to see the answer">Each question comes back with probabilities. Scaper then applies your threshold.</EmptyState>}
            {res && view === "answers" && (
              <>
                <Callout tone={res.read.outcome === "clear" ? "success" : "warning"} icon={res.read.outcome === "clear" ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
                  title={res.read.outcome === "clear" ? `Every answer is confident at ${pct(res.threshold)}` : `Some answers are unsure at ${pct(res.threshold)}`}>
                  {res.read.outcome === "clear" ? "Each answer is a clear yes, no or option. Read them below; whether that means go or stop is up to your rules." : `A person should look: ${res.read.reasons.join(" ")}`}
                </Callout>
                {Object.entries(sentQuestions).map(([name, q]) => (
                  <AnswerCard key={name} name={name} q={q} a={res.result.answers[name]} line={res.read.lines.find((l) => l.name === name)} threshold={res.threshold} />
                ))}
                <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <div><p className="text-xs text-muted">Time</p><p className="tabular-nums">{(res.result.latencyMs / 1000).toFixed(2)}s</p></div>
                  <div><p className="text-xs text-muted">Input tokens</p><p className="tabular-nums">{res.result.usage.inputTokens ? res.result.usage.inputTokens.toLocaleString("en-IN") : "Not reported"}</p></div>
                  <div><p className="text-xs text-muted">Cost</p><p className="tabular-nums">{money(res.result.usage.cost)}</p></div>
                  <div className="min-w-0"><p className="text-xs text-muted">Request</p><p className="truncate font-mono text-xs" title={res.result.id}>{res.result.id}</p></div>
                </div>
              </>
            )}
            {res && view === "raw" && (
              <div>
                <div className="mb-1 flex justify-end"><CopyButton text={JSON.stringify(res.result, null, 2)} /></div>
                <pre className="scroll-thin max-h-[560px] overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">{JSON.stringify(res.result, null, 2)}</pre>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function DecisionsPage() {
  const [tab, setTab] = useQueryState<Tab>("tab", "check");
  const [initialUrl] = useQueryState<string>("url", "");
  const status = useApi<Status>("/api/decisions");
  const [linkSeed, setLinkSeed] = useState({ url: "", goal: "", key: 0 });
  const s = status.data;
  return (
    <>
      <PageHeader title="Decisions"
        description="Your decision model answers precise questions with probabilities: is this page OK to scrape, which links hold what you want, should the agent ask first. Scaper's rules always come first."
        actions={<Link prefetch={false} href="/settings?tab=ai"><Button variant="secondary" size="sm">Decision model settings</Button></Link>} />
      {status.error ? <Card><ErrorNote message={status.error} onRetry={() => void status.reload()} /></Card> : !s ? <div className="skeleton h-24 rounded-xl" /> : (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Decision model" value={<span className="flex items-center gap-2 text-base">{s.ready ? <CheckCircle2 className="size-4 text-success" aria-hidden /> : <AlertTriangle className="size-4 text-warning" aria-hidden />}{s.ready ? "On" : s.provider ? "Off" : "Not set up"}</span>} hint={<span className="font-mono">{s.model}</span>} />
            <Stat label="Provider" value={<span className="text-base">{s.provider?.name ?? "–"}</span>} hint={<span className="block truncate font-mono" title={s.endpoint ?? ""}>{s.endpoint ?? "Add OpenRouter in Settings → AI"}</span>} />
            <Stat label="Used for" value={<span className="text-base">{[s.uses.pickLinks && "links", s.uses.scrapeCheck && "checks", s.uses.agentGuard && "agent"].filter(Boolean).join(", ") || "nothing"}</span>} hint={s.ready ? "in category scrapes, checks and the agent" : "turn it on to use it outside this page"} />
            <Stat label="Thresholds" value={<span className="text-base tabular-nums">{pct(s.linkThreshold)} · {pct(s.riskThreshold)}</span>} hint="link match · risk flag" />
          </div>
          <Tabs value={tab} onChange={setTab} tabs={[
            { value: "check", label: "OK to scrape?", icon: <ShieldCheck className="size-4" /> },
            { value: "links", label: "Find what to scrape", icon: <ListChecks className="size-4" /> },
            { value: "playground", label: "Playground", icon: <FlaskConical className="size-4" /> },
          ]} />
          {tab === "check" && <CheckTab status={s} initialUrl={initialUrl} onPickLinks={(url, goal) => { setLinkSeed((x) => ({ url, goal, key: x.key + 1 })); setTab("links"); }} />}
          {tab === "links" && <LinksTab key={linkSeed.key} status={s} initial={linkSeed} />}
          {tab === "playground" && <PlaygroundTab status={s} />}
          <Callout icon={<ShieldCheck className="size-4 text-accent" />} title="How the answers are used">
            Probabilities are estimates, not facts. Scaper compares them with your thresholds in code: robots.txt, refused pages and bot checks always stop a scrape, deleting always asks, and the model can add caution but never remove it. Every call is in the <Link prefetch={false} href="/ai-log" className="text-accent hover:underline">AI log</Link>.
          </Callout>
        </div>
      )}
    </>
  );
}

export default function Page() {
  return <Suspense><DecisionsPage /></Suspense>;
}
