"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BookMarked, Globe, MousePointerClick, Play, Plus, Save, Sparkles, Trash2, Wand2, Zap, ListTree } from "lucide-react";
import { ConfirmDialog, Dialog } from "@/components/dialog";
import { ElementPicker, type PickAction } from "@/components/element-picker";
import { ScrapeResultView, type RunView } from "@/components/scrape-result";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, CardHeader, Field, Input, PageHeader, Segmented, Select, Switch, Textarea } from "@/components/ui";
import { api, ClientApiError, errorText } from "@/lib/api-client";
import type { ExtractSpec, FetchMode, Field as FieldSpec } from "@/lib/schemas";
import { hostOf, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type ExtractType = ExtractSpec["type"];
type Recipe = { id: string; name: string; url: string; mode: FetchMode; extract: ExtractSpec; updated_at: string; schedule_minutes: number | null; next_run_at: string | null; last_status: string | null };

const ATTRS = ["text", "href", "src", "html", "title", "alt", "content", "value", "data-price"];
const emptyField = (): FieldSpec => ({ name: "", selector: "", attr: "text", multiple: false });

function ScrapePage() {
  const params = useSearchParams();
  const toast = useToast();
  const recipes = useApi<{ recipes: Recipe[] }>("/api/recipes");

  const [url, setUrl] = useState(params.get("url") ?? "");
  const [mode, setMode] = useState<FetchMode>("browser");
  const [type, setType] = useState<ExtractType>("auto");
  const [itemSelector, setItemSelector] = useState("");
  const [fields, setFields] = useState<FieldSpec[]>([{ name: "title", selector: "h1", attr: "text", multiple: false }]);
  const [instruction, setInstruction] = useState("");
  const [fastModel, setFastModel] = useState(true);
  const [screenshot, setScreenshot] = useState(false);
  const [recipeId, setRecipeId] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [run, setRun] = useState<RunView | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [recipeName, setRecipeName] = useState("");
  const [schedule, setSchedule] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<Recipe | null>(null);
  const [picking, setPicking] = useState(false);

  const onPick = (a: PickAction) => {
    if (a.kind === "item") {
      setItemSelector(a.selector);
      toast.info("Item selector set", "Now pick the title, price and other parts inside one item.");
      return;
    }
    setFields((fs) => {
      const names = new Set(fs.map((f) => f.name));
      let name = a.name;
      for (let n = 2; names.has(name); n++) name = `${a.name}_${n}`;
      const next = { name, selector: a.selector, attr: a.attr, multiple: a.multiple };
      // Replace the untouched starter field instead of keeping it around.
      const starter = fs.length === 1 && fs[0]!.name === "title" && fs[0]!.selector === "h1";
      return starter ? [next] : [...fs, next];
    });
  };

  const extract = (): ExtractSpec =>
    type === "auto" ? { type } : type === "selectors" ? { type, itemSelector, fields } : { type, instruction, useFastModel: fastModel };

  const loadRecipe = (r: Recipe) => {
    setRecipeId(r.id);
    setRecipeName(r.name);
    setSchedule(r.schedule_minutes);
    setUrl(r.url);
    setMode(r.mode);
    setType(r.extract.type);
    if (r.extract.type === "selectors") { setItemSelector(r.extract.itemSelector ?? ""); setFields(r.extract.fields); }
    if (r.extract.type === "ai") { setInstruction(r.extract.instruction); setFastModel(r.extract.useFastModel); }
  };

  const recipeParam = params.get("recipe");
  const recipeList = recipes.data?.recipes;
  useEffect(() => {
    const r = recipeParam && recipeList?.find((x) => x.id === recipeParam);
    // Pre-fill the form once when opened from a recipe link.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (r) loadRecipe(r);
  }, [recipeParam, recipeList]);

  const submit = async () => {
    setBusy(true);
    setErrors({});
    try {
      const res = await api<{ run: RunView }>("/api/scrape", { body: { url, mode, extract: extract(), screenshot, recipeId: recipeId ?? undefined } });
      setRun(res.run);
      if (res.run.status === "ok") toast.success("Scrape finished", `${res.run.row_count} ${res.run.row_count === 1 ? "row" : "rows"} from ${hostOf(url)}`);
    } catch (e) {
      if (e instanceof ClientApiError && e.fields) setErrors(e.fields);
      toast.error("Could not scrape", errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const saveRecipe = async () => {
    try {
      const body = { name: recipeName, url, mode, extract: extract(), scheduleMinutes: schedule };
      const res = recipeId
        ? await api<{ recipe: Recipe }>(`/api/recipes/${recipeId}`, { method: "PUT", body })
        : await api<{ recipe: Recipe }>("/api/recipes", { body });
      setRecipeId(res.recipe.id);
      setSaveOpen(false);
      void recipes.reload();
      toast.success("Recipe saved", "Run it again any time from the list.");
    } catch (e) {
      if (e instanceof ClientApiError && e.fields) setErrors(e.fields);
      toast.error("Could not save", errorText(e));
    }
  };

  const updateField = (i: number, patch: Partial<FieldSpec>) => setFields((fs) => fs.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));

  return (
    <>
      <PageHeader title="Scrape" description="Pull data out of any page. Scaper waits its turn per site and respects robots.txt." />
      <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
        <div className="min-w-0 space-y-6">
          <Card>
            <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-5 p-5">
              <Field label="Page URL" error={errors.url}>
                {(p) => <Input {...p} type="url" inputMode="url" placeholder="https://www.example.com/products" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus required />}
              </Field>

              <div className="flex flex-wrap gap-x-8 gap-y-4">
                <div>
                  <p className="mb-1.5 text-sm font-medium">How to load it</p>
                  <Segmented label="Fetch mode" value={mode} onChange={setMode} options={[
                    { value: "browser", label: "Browser", icon: <Globe className="size-4" /> },
                    { value: "fast", label: "Fast", icon: <Zap className="size-4" /> },
                  ]} />
                  <p className="mt-1.5 text-xs text-muted">{mode === "browser" ? "Runs JavaScript like a real browser. Works on most modern sites." : "Plain HTTP, no JavaScript. Much faster and lighter."}</p>
                </div>
                <div>
                  <p className="mb-1.5 text-sm font-medium">What to extract</p>
                  <Segmented label="Extraction type" value={type} onChange={setType} options={[
                    { value: "auto", label: "Auto", icon: <Wand2 className="size-4" /> },
                    { value: "selectors", label: "Selectors", icon: <ListTree className="size-4" /> },
                    { value: "ai", label: "AI", icon: <Sparkles className="size-4" /> },
                  ]} />
                  <p className="mt-1.5 text-xs text-muted">
                    {type === "auto" && "Finds product lists, tables, structured data, links and images by itself."}
                    {type === "selectors" && "Exact CSS selectors. Best for repeat jobs and watchers."}
                    {type === "ai" && "Describe what you want in plain words. Uses your own AI model."}
                  </p>
                </div>
              </div>

              {type === "selectors" && (
                <div className="space-y-3 rounded-xl border border-border bg-surface-2/40 p-4">
                  <Field label="Item selector (optional)" hint="One row per match, e.g. div.product-card. Leave empty to read fields from the whole page." error={errors["extract.itemSelector"]}>
                    {(p) => <Input {...p} className="font-mono" placeholder=".product-card" value={itemSelector} onChange={(e) => setItemSelector(e.target.value)} />}
                  </Field>
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Fields</p>
                    {fields.map((f, i) => (
                      <div key={i} className="grid gap-2 sm:grid-cols-[140px_1fr_120px_auto_auto]">
                        <Input aria-label={`Field ${i + 1} name`} placeholder="name" value={f.name} onChange={(e) => updateField(i, { name: e.target.value })} invalid={Boolean(errors[`extract.fields.${i}.name`])} />
                        <Input aria-label={`Field ${i + 1} selector`} className="font-mono" placeholder="h2 a" value={f.selector} onChange={(e) => updateField(i, { selector: e.target.value })} invalid={Boolean(errors[`extract.fields.${i}.selector`])} />
                        <Select aria-label={`Field ${i + 1} value`} value={ATTRS.includes(f.attr) ? f.attr : "text"} onChange={(e) => updateField(i, { attr: e.target.value })}>
                          {ATTRS.map((a) => <option key={a} value={a}>{a}</option>)}
                        </Select>
                        <label className="flex h-11 items-center gap-2 text-sm text-muted">
                          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={f.multiple} onChange={(e) => updateField(i, { multiple: e.target.checked })} /> all
                        </label>
                        <Button type="button" variant="ghost" aria-label={`Remove field ${i + 1}`} onClick={() => setFields((fs) => fs.filter((_, idx) => idx !== i))} disabled={fields.length === 1}><Trash2 className="size-4" /></Button>
                      </div>
                    ))}
                    {errors["extract.fields"] && <p className="text-xs text-danger">{errors["extract.fields"]}</p>}
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setFields((fs) => [...fs, emptyField()])} disabled={fields.length >= 30}>Add field</Button>
                      <Button type="button" size="sm" variant="secondary" icon={<MousePointerClick className="size-4" />} onClick={() => setPicking(true)} disabled={!url}>Pick on page</Button>
                    </div>
                  </div>
                </div>
              )}

              {type === "ai" && (
                <div className="space-y-3 rounded-xl border border-border bg-surface-2/40 p-4">
                  <Field label="What should the AI extract?" error={errors["extract.instruction"]} hint="The page text is sent to the AI provider you set in Settings.">
                    {(p) => <Textarea {...p} placeholder="Every product with name, price, original price, discount % and rating" value={instruction} onChange={(e) => setInstruction(e.target.value)} />}
                  </Field>
                  <Switch checked={fastModel} onChange={setFastModel} label="Use the fast model" description="Cheaper and quicker. Turn off for long or tricky pages." />
                </div>
              )}

              <Switch checked={screenshot} onChange={setScreenshot} label="Take a screenshot" description="Browser mode only. Loads images, so it is a little slower." disabled={mode === "fast"} />

              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                <Button type="submit" loading={busy} icon={<Play className="size-4" />}>{busy ? "Scraping…" : "Scrape"}</Button>
                <Button type="button" variant="secondary" icon={<Save className="size-4" />} onClick={() => { if (!recipeName) setRecipeName(hostOf(url)); setSaveOpen(true); }} disabled={!url}>
                  {recipeId ? "Update recipe" : "Save as recipe"}
                </Button>
                {recipeId && <Button type="button" variant="ghost" onClick={() => { setRecipeId(null); setRecipeName(""); setSchedule(null); }}>Start new</Button>}
              </div>
            </form>
          </Card>

          {busy && !run && <Card className="p-5"><div className="skeleton h-40 rounded-lg" role="status" aria-label="Scraping" /></Card>}
          {run && <ScrapeResultView run={run} onUseSelectors={(s) => { setType("selectors"); setItemSelector(s.itemSelector); setFields(s.fields); window.scrollTo({ top: 0, behavior: "smooth" }); toast.info("Selectors loaded", "Rename or adjust the fields, then scrape again."); }} />}
        </div>

        <Card className="h-fit">
          <CardHeader title="Recipes" description="Saved scrapes you can rerun." />
          {recipes.loading ? <div className="p-5"><div className="skeleton h-20 rounded-lg" /></div> : !recipes.data?.recipes.length ? (
            <div className="flex flex-col items-center px-5 py-8 text-center text-sm text-muted"><BookMarked className="mb-2 size-5" />Save a scrape to reuse it with one click.</div>
          ) : (
            <ul className="divide-y divide-border">
              {recipes.data.recipes.map((r) => (
                <li key={r.id} className="flex items-center gap-2 px-4 py-3">
                  <button className="min-w-0 flex-1 text-left" onClick={() => loadRecipe(r)}>
                    <p className="truncate text-sm font-medium hover:text-accent">{r.name}</p>
                    <p className="truncate text-xs text-muted">{hostOf(r.url)} · <Badge className="ml-0.5">{r.extract.type}</Badge> · {r.schedule_minutes ? <>auto, next {timeAgo(r.next_run_at)}{r.last_status && r.last_status !== "ok" && <span className="text-warning"> · last {r.last_status}</span>}</> : timeAgo(r.updated_at)}</p>
                  </button>
                  <Button size="sm" variant="ghost" aria-label={`Delete ${r.name}`} onClick={() => setDeleting(r)}><Trash2 className="size-4" /></Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Dialog open={saveOpen} onClose={() => setSaveOpen(false)} title={recipeId ? "Update recipe" : "Save recipe"}
        footer={<><Button variant="secondary" onClick={() => setSaveOpen(false)}>Cancel</Button><Button onClick={saveRecipe} disabled={!recipeName.trim()}>Save</Button></>}>
        <div className="space-y-4">
          <Field label="Recipe name" error={errors.name}>{(p) => <Input {...p} autoFocus value={recipeName} onChange={(e) => setRecipeName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void saveRecipe(); }} />}</Field>
          <Field label="Run automatically" hint="Each run is saved in History and as a CSV file in data/exports/." error={errors.scheduleMinutes}>
            {(p) => (
              <Select {...p} value={schedule ?? ""} onChange={(e) => setSchedule(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Off (run by hand)</option>
                <option value={60}>Every hour</option>
                <option value={360}>Every 6 hours</option>
                <option value={720}>Every 12 hours</option>
                <option value={1440}>Daily</option>
                <option value={10080}>Weekly</option>
              </Select>
            )}
          </Field>
        </div>
      </Dialog>

      <ElementPicker open={picking} url={url} onClose={() => setPicking(false)} onPick={onPick} itemSelector={itemSelector} />

      <ConfirmDialog open={Boolean(deleting)} onCancel={() => setDeleting(null)} title="Delete recipe?"
        body={<>“{deleting?.name}” will be removed. Past runs stay in History.</>}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api(`/api/recipes/${deleting.id}`, { method: "DELETE" });
            if (recipeId === deleting.id) setRecipeId(null);
            toast.success("Recipe deleted");
            void recipes.reload();
          } catch (e) { toast.error("Could not delete", errorText(e)); }
          setDeleting(null);
        }} />
    </>
  );
}

export default function Page() {
  return <Suspense><ScrapePage /></Suspense>;
}
