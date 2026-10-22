"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, FlaskConical, Plus, Trash2 } from "lucide-react";
import type { BrowserStep } from "@/lib/schemas";
import { api, errorText } from "@/lib/api-client";
import { Dialog } from "./dialog";
import { Badge, Button, Callout, Checkbox, IconButton, Input, Select } from "./ui";

type StepAction = BrowserStep["action"];

const ACTIONS: { value: StepAction; label: string; hint: string }[] = [
  { value: "click", label: "Click element", hint: "A button or link (CSS selector)" },
  { value: "clickText", label: "Click text", hint: "Click the first element showing this text" },
  { value: "type", label: "Type text", hint: "Fill a search box or form field" },
  { value: "press", label: "Press key", hint: "Enter, Escape, ArrowDown …" },
  { value: "select", label: "Choose option", hint: "Pick a value in a dropdown" },
  { value: "check", label: "Tick checkbox", hint: "Check or uncheck a box" },
  { value: "hover", label: "Hover", hint: "Open a menu that shows on hover" },
  { value: "waitFor", label: "Wait for element", hint: "Until it is visible" },
  { value: "waitForText", label: "Wait for text", hint: "Until the text appears" },
  { value: "wait", label: "Wait seconds", hint: "A fixed pause" },
  { value: "scroll", label: "Scroll down", hint: "Load lazy content" },
  { value: "remove", label: "Hide elements", hint: "Remove cookie banners or overlays from the content" },
];

export function blankStep(action: StepAction): BrowserStep {
  switch (action) {
    case "click": return { action, selector: "", optional: false };
    case "clickText": return { action, text: "", optional: false };
    case "type": return { action, selector: "", text: "", submit: false };
    case "press": return { action, key: "Enter" };
    case "select": return { action, selector: "", value: "" };
    case "check": return { action, selector: "", checked: true };
    case "hover": return { action, selector: "" };
    case "waitFor": return { action, selector: "", timeoutSeconds: 10 };
    case "waitForText": return { action, text: "", timeoutSeconds: 10 };
    case "wait": return { action, seconds: 2 };
    case "scroll": return { action, times: 3 };
    case "remove": return { action, selector: "" };
  }
}

function StepFields({ step, onChange }: { step: BrowserStep; onChange: (s: BrowserStep) => void }) {
  const sel = (placeholder = "CSS selector, e.g. button.accept") => "selector" in step && (
    <Input aria-label="Selector" className="h-10 font-mono text-xs" placeholder={placeholder} value={step.selector} onChange={(e) => onChange({ ...step, selector: e.target.value } as BrowserStep)} />
  );
  switch (step.action) {
    case "click":
      return <div className="flex flex-wrap items-center gap-3">{sel()}<Checkbox label="Skip if missing" checked={step.optional} onChange={(v) => onChange({ ...step, optional: v })} /></div>;
    case "clickText":
      return <div className="flex flex-wrap items-center gap-3"><Input aria-label="Text" className="h-10" placeholder="Accept all" value={step.text} onChange={(e) => onChange({ ...step, text: e.target.value })} /><Checkbox label="Skip if missing" checked={step.optional} onChange={(v) => onChange({ ...step, optional: v })} /></div>;
    case "type":
      return (
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-center">
          {sel("input[name=q]")}
          <Input aria-label="Text to type" className="h-10" placeholder="Text (use {{column}} with CSV inputs)" value={step.text} onChange={(e) => onChange({ ...step, text: e.target.value })} />
          <Checkbox label="Press Enter" checked={step.submit} onChange={(v) => onChange({ ...step, submit: v })} />
        </div>
      );
    case "press":
      return <Input aria-label="Key" className="h-10 w-48" placeholder="Enter" value={step.key} onChange={(e) => onChange({ ...step, key: e.target.value })} />;
    case "select":
      return <div className="grid gap-2 sm:grid-cols-2">{sel("select#city")}<Input aria-label="Option value" className="h-10" placeholder="Option value or label" value={step.value} onChange={(e) => onChange({ ...step, value: e.target.value })} /></div>;
    case "check":
      return <div className="flex flex-wrap items-center gap-3">{sel("input#in-stock")}<Checkbox label="Checked" checked={step.checked} onChange={(v) => onChange({ ...step, checked: v })} /></div>;
    case "hover":
    case "remove":
      return sel(step.action === "remove" ? "#cookie-banner, .modal-backdrop" : undefined);
    case "waitFor":
      return <div className="flex flex-wrap items-center gap-2">{sel(".results")}<Input aria-label="Timeout seconds" type="number" min={1} max={60} className="h-10 w-24" value={step.timeoutSeconds} onChange={(e) => onChange({ ...step, timeoutSeconds: Number(e.target.value) || 10 })} /><span className="text-xs text-muted">s max</span></div>;
    case "waitForText":
      return <div className="flex flex-wrap items-center gap-2"><Input aria-label="Text" className="h-10 flex-1" placeholder="results found" value={step.text} onChange={(e) => onChange({ ...step, text: e.target.value })} /><Input aria-label="Timeout seconds" type="number" min={1} max={60} className="h-10 w-24" value={step.timeoutSeconds} onChange={(e) => onChange({ ...step, timeoutSeconds: Number(e.target.value) || 10 })} /><span className="text-xs text-muted">s max</span></div>;
    case "wait":
      return <div className="flex items-center gap-2"><Input aria-label="Seconds" type="number" min={0.1} max={30} step={0.5} className="h-10 w-28" value={step.seconds} onChange={(e) => onChange({ ...step, seconds: Number(e.target.value) || 1 })} /><span className="text-xs text-muted">seconds</span></div>;
    case "scroll":
      return <div className="flex items-center gap-2"><Input aria-label="Times" type="number" min={1} max={50} className="h-10 w-24" value={step.times} onChange={(e) => onChange({ ...step, times: Number(e.target.value) || 1 })} /><span className="text-xs text-muted">screens</span></div>;
  }
}

/**
 * Page actions run in the browser before reading the page: accept a cookie banner,
 * search, pick a city, log in to your own account. Test runs them and shows the result.
 */
export function StepsEditor({ steps, onChange, url, max = 30 }: { steps: BrowserStep[]; onChange: (s: BrowserStep[]) => void; url: string; max?: number }) {
  const [adding, setAdding] = useState<StepAction>("click");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; log: string[]; screenshot: string | null; title?: string; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const update = (i: number, s: BrowserStep) => onChange(steps.map((x, k) => (k === i ? s : x)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const test = async () => {
    setTesting(true); setError(null); setResult(null);
    try { setResult(await api("/api/steps/test", { body: { url, steps } })); }
    catch (e) { setError(errorText(e)); }
    finally { setTesting(false); }
  };

  return (
    <div className="space-y-3">
      {steps.length === 0 && <p className="text-sm text-muted">No page actions. The page is read as soon as it loads.</p>}
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={i} className="rounded-xl border border-border bg-surface-2/40 p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="flex size-6 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{i + 1}</span>
              <Select aria-label="Action" className="h-9 w-48" value={s.action} onChange={(e) => update(i, blankStep(e.target.value as StepAction))}>
                {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </Select>
              <span className="hidden text-xs text-muted md:inline">{ACTIONS.find((a) => a.value === s.action)?.hint}</span>
              <span className="ml-auto flex">
                <IconButton size="sm" label="Move up" onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp className="size-4" /></IconButton>
                <IconButton size="sm" label="Move down" onClick={() => move(i, 1)} disabled={i === steps.length - 1}><ArrowDown className="size-4" /></IconButton>
                <IconButton size="sm" label="Remove step" onClick={() => onChange(steps.filter((_, k) => k !== i))}><Trash2 className="size-4" /></IconButton>
              </span>
            </div>
            <StepFields step={s} onChange={(n) => update(i, n)} />
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="New step" className="h-9 w-48" value={adding} onChange={(e) => setAdding(e.target.value as StepAction)}>
          {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </Select>
        <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} disabled={steps.length >= max} onClick={() => onChange([...steps, blankStep(adding)])}>Add step</Button>
        {steps.length > 0 && <Button size="sm" variant="ghost" icon={<FlaskConical className="size-4" />} loading={testing} disabled={!url} onClick={test}>Test in browser</Button>}
      </div>
      {error && <Callout tone="danger" title="Test failed">{error}</Callout>}
      <Dialog open={result !== null} onClose={() => setResult(null)} wide title={result?.ok ? "Steps ran" : "A step failed"} description={result?.title}>
        {result && (
          <div className="space-y-3">
            <ul className="space-y-1 text-sm">
              {result.log.map((l, i) => <li key={i} className="flex items-start gap-2"><Badge tone={/failed/.test(l) ? "danger" : /skipped/.test(l) ? "warning" : "success"}>{/failed/.test(l) ? "fail" : /skipped/.test(l) ? "skip" : "ok"}</Badge><span>{l}</span></li>)}
            </ul>
            {/* eslint-disable-next-line @next/next/no-img-element -- base64 screenshot from the server */}
            {result.screenshot && <img src={`data:image/jpeg;base64,${result.screenshot}`} alt="The page after the steps" className="w-full rounded-lg border border-border" />}
          </div>
        )}
      </Dialog>
    </div>
  );
}
