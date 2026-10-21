"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bot, CheckCircle2, ChevronRight, Send, Wrench, XCircle } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, Switch, Textarea } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type Step = { type: "thought"; text: string } | { type: "tool"; name: string; args: Record<string, unknown>; result: string; ok: boolean } | { type: "answer"; text: string };
type Run = { id: string; prompt: string; model: string; status: "running" | "done" | "error"; steps: Step[]; answer: string | null; error: string | null; tokens_in: number; tokens_out: number; created_at: string };

const EXAMPLES = [
  "Find the 10 highest-discount wireless earbuds on https://www.amazon.in/s?k=wireless+earbuds with at least 4 stars, and tell me which discounts look real.",
  "Open https://news.ycombinator.com and list the top 10 stories with their points.",
  "Watch https://example.com/careers and alert me when a job with \"Backend\" in the title appears. Check every 3 hours.",
  "Compare the prices of my tracked products and tell me which one is the best buy today.",
];

const TOOL_LABEL: Record<string, string> = {
  open_page: "Opened page", extract_items: "Extracted items", extract_with_selectors: "Extracted with selectors", scan_deals: "Scanned deals",
  price_history: "Checked price history", list_tracked_products: "Listed tracked products", track_product: "Started tracking",
  list_watchers: "Listed watchers", create_watcher: "Created watcher", notify_user: "Sent notification",
};

function StepView({ step }: { step: Step }) {
  if (step.type === "answer") return null;
  if (step.type === "thought") return <p className="text-sm text-muted italic">{step.text}</p>;
  const target = typeof step.args.url === "string" ? step.args.url : typeof step.args.name === "string" ? step.args.name : "";
  return (
    <details className="group rounded-lg border border-border bg-surface-2/40">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm">
        <ChevronRight className="size-4 shrink-0 text-muted transition-transform group-open:rotate-90" aria-hidden />
        {step.ok ? <Wrench className="size-4 shrink-0 text-accent" /> : <XCircle className="size-4 shrink-0 text-danger" />}
        <span className="font-medium">{TOOL_LABEL[step.name] ?? step.name}</span>
        <span className="min-w-0 truncate text-muted">{target}</span>
      </summary>
      <pre className="max-h-64 overflow-auto border-t border-border px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted">{step.result}</pre>
    </details>
  );
}

export default function AgentPage() {
  const toast = useToast();
  const history = useApi<{ runs: Run[] }>("/api/agent/runs");
  const settings = useApi<{ settings: { ai: { baseUrl: string; model: string; fastModel: string } } }>("/api/settings");
  const [prompt, setPrompt] = useState("");
  const [fast, setFast] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [starting, setStarting] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const ai = settings.data?.settings.ai;
  const configured = Boolean(ai?.baseUrl && (ai.model || ai.fastModel));

  const watch = (id: string) => {
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      try {
        const r = await api<{ run: Run }>(`/api/agent/runs/${id}`);
        setRun(r.run);
        if (r.run.status !== "running") {
          clearInterval(poll.current!);
          void history.reload();
        }
      } catch { /* keep polling; transient */ }
    }, 1200);
  };
  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);

  const start = async () => {
    setStarting(true);
    try {
      const r = await api<{ run: Run }>("/api/agent", { body: { prompt, useFastModel: fast } });
      setRun(r.run);
      watch(r.run.id);
    } catch (e) { toast.error("Agent could not start", errorText(e)); } finally { setStarting(false); }
  };

  const running = run?.status === "running";

  return (
    <>
      <PageHeader title="Agent" description="Tell it what you want in plain words. It scrapes, compares, tracks and watches using your own AI model." />
      {settings.data && !configured && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning-soft/50 p-4 text-sm">
          <p>Connect an OpenAI-compatible model first (OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio…).</p>
          <Link href="/settings" className="font-medium text-accent hover:underline">Open Settings</Link>
        </div>
      )}
      <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
        <div className="min-w-0 space-y-6">
          <Card>
            <form onSubmit={(e) => { e.preventDefault(); void start(); }} className="space-y-4 p-5">
              <Textarea aria-label="Task for the agent" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Find the best real deals on 55-inch TVs on Amazon India…" className="min-h-28"
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim().length >= 3) void start(); }} />
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((ex) => (
                  <button type="button" key={ex} onClick={() => setPrompt(ex)} className="max-w-full truncate rounded-full border border-border px-3 py-1.5 text-xs text-muted hover:border-accent hover:text-accent">{ex.slice(0, 60)}…</button>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
                <div className="w-72 max-w-full"><Switch checked={fast} onChange={setFast} label="Fast mode" description={`Use ${ai?.fastModel || "the fast model"} for quick, cheap tasks.`} /></div>
                <Button type="submit" loading={starting || running} disabled={!configured || prompt.trim().length < 3} icon={<Send className="size-4" />}>{running ? "Working…" : "Run"}</Button>
              </div>
            </form>
          </Card>

          {run && (
            <Card>
              <CardHeader title={<span className="flex items-center gap-2">{run.status === "running" ? <span className="size-2 animate-pulse rounded-full bg-accent" /> : run.status === "done" ? <CheckCircle2 className="size-4 text-success" /> : <XCircle className="size-4 text-danger" />}Result</span>}
                description={`${run.model} · ${run.steps.filter((s) => s.type === "tool").length} tool calls · ${(run.tokens_in + run.tokens_out).toLocaleString("en-IN")} tokens`} />
              <div className="space-y-3 p-5">
                <p className="rounded-lg bg-surface-2/60 px-3 py-2 text-sm">{run.prompt}</p>
                {run.steps.map((s, i) => <StepView key={i} step={s} />)}
                {running && <div className="skeleton h-10 rounded-lg" role="status" aria-label="Agent working" />}
                {run.status === "error" && <p role="alert" className="rounded-lg bg-danger-soft/60 p-3 text-sm text-danger">{run.error}</p>}
                {run.answer && <div className="border-t border-border pt-4"><Markdown text={run.answer} /></div>}
              </div>
            </Card>
          )}
        </div>

        <Card className="h-fit">
          <CardHeader title="Recent runs" />
          {!history.data?.runs.length ? (
            <EmptyState icon={<Bot className="size-5" />} title="No runs yet">Your agent runs appear here.</EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {history.data.runs.map((r) => (
                <li key={r.id}>
                  <button onClick={() => { setRun(r); if (r.status === "running") watch(r.id); }} className={cn("w-full px-4 py-3 text-left hover:bg-surface-2/50", run?.id === r.id && "bg-accent-soft/40")}>
                    <p className="line-clamp-2 text-sm">{r.prompt}</p>
                    <p className="mt-1 flex items-center gap-2 text-xs text-muted">
                      <Badge tone={r.status === "done" ? "success" : r.status === "error" ? "danger" : "accent"}>{r.status}</Badge>{timeAgo(r.created_at)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
