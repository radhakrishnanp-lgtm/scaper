"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpLeft, Crosshair, Link2, ListPlus, Rows3 } from "lucide-react";
import { Dialog } from "./dialog";
import { Badge, Button, ErrorNote } from "./ui";
import { api, errorText } from "@/lib/api-client";
import type { BrowserStep } from "@/lib/schemas";
import { plural } from "@/lib/format";

type Box = { x: number; y: number; w: number; h: number; tag: string; text: string; selector: string; general: string; similar: number; href: string | null; src: string | null };
type Inspect = { url: string; title: string; screenshot: string; width: number; height: number; boxes: Box[] };

export type PickAction =
  | { kind: "field"; selector: string; attr: string; multiple: boolean; name: string }
  | { kind: "item"; selector: string };

const SHOT_WIDTH = 1366;

/** Smallest box under the pointer = the most specific element. */
function hit(boxes: Box[], x: number, y: number) {
  let best: Box | null = null;
  for (const b of boxes) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h && (!best || b.w * b.h < best.w * best.h)) best = b;
  }
  return best;
}

/** Smallest box that fully contains `b` (its visual parent). */
function parentOf(boxes: Box[], b: Box) {
  let best: Box | null = null;
  for (const o of boxes) {
    if (o === b || o.w * o.h <= b.w * b.h) continue;
    if (o.x <= b.x && o.y <= b.y && o.x + o.w >= b.x + b.w && o.y + o.h >= b.y + b.h && (!best || o.w * o.h < best.w * best.h)) best = o;
  }
  return best;
}

const KEYWORDS: [RegExp, string][] = [
  [/price|cost|amount|mrp/i, "price"], [/title|heading|headline/i, "title"], [/\bname\b|product-?name/i, "name"],
  [/rating|stars?/i, "rating"], [/reviews?|ratings-?count/i, "reviews"], [/brand|vendor|seller/i, "brand"],
  [/date|time|posted|published/i, "date"], [/author|byline/i, "author"], [/desc|summary|excerpt|snippet/i, "description"],
  [/stock|availability/i, "availability"], [/sku|model|part/i, "sku"], [/categor|breadcrumb/i, "category"],
  [/discount|saving|off\b/i, "discount"], [/location|address|city/i, "location"],
];

/** A useful column name from the element's classes, tag and text, so picked fields don't end up as field_2. */
function guessName(b: Box) {
  if (b.tag === "img") return "image";
  const classes = (b.general.split(" > ").pop() ?? "").split(".").slice(1).join(" ");
  for (const [re, name] of KEYWORDS) if (re.test(classes)) return name;
  if (b.tag === "time") return "date";
  if (/^h[1-6]$/.test(b.tag)) return "title";
  if (/[₹$€£]|\bRs\.?|\bINR\b/.test(b.text) && b.text.length < 30) return "price";
  if (/^\d(\.\d)?\s*(out of 5|\/\s*5|★)/i.test(b.text)) return "rating";
  if (/^[\d,]+\s*(reviews?|ratings?)$/i.test(b.text)) return "reviews";
  if (b.tag === "a") return b.text.length > 12 ? "title" : "link";
  return "text";
}

/**
 * Selector for a field inside the chosen item: drop everything up to and including
 * the item's own segment, otherwise keep the last one or two parts.
 */
export function relativeSelector(general: string, itemSelector: string) {
  const parts = general.split(" > ");
  const itemLast = itemSelector.split(" > ").pop()?.trim();
  const at = itemLast ? parts.lastIndexOf(itemLast) : -1;
  if (at >= 0 && at < parts.length - 1) return parts.slice(at + 1).join(" > ");
  const rest = parts.filter((p) => !p.startsWith("#"));
  return rest.slice(-2).join(" > ") || general;
}

export function ElementPicker({ url, open, onClose, onPick, itemSelector, steps = [] }: {
  url: string; open: boolean; onClose: () => void; onPick: (a: PickAction) => void; itemSelector: string; steps?: BrowserStep[];
}) {
  const hasItemSelector = Boolean(itemSelector.trim());
  const [data, setData] = useState<Inspect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hover, setHover] = useState<Box | null>(null);
  const [picked, setPicked] = useState<Box | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const imgRef = useRef<HTMLImageElement>(null);

  const load = async () => {
    setLoading(true); setError(null); setPicked(null);
    try {
      const d = await api<Inspect>("/api/inspect", { body: { url, steps } });
      setData(d); setLoadedUrl(url);
    } catch (e) { setError(errorText(e)); } finally { setLoading(false); }
  };
  useEffect(() => {
    // Load the page when the picker opens for a new URL.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open && loadedUrl !== url) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is recreated each render; url/open are the real triggers
  }, [open, url]);

  const scale = () => (imgRef.current ? imgRef.current.clientWidth / Math.min(data?.width ?? SHOT_WIDTH, SHOT_WIDTH) : 1);
  const toPage = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const s = scale();
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
  };
  const boxes = useMemo(() => data?.boxes ?? [], [data]);
  const highlight = picked ?? hover;
  const shotWidth = Math.min(data?.width ?? SHOT_WIDTH, SHOT_WIDTH);
  const similarBoxes = useMemo(() => (picked && picked.similar > 1 ? boxes.filter((b) => b.general === picked.general) : []), [picked, boxes]);

  // Fields keep the picker open so several can be picked in a row; choosing the item selector closes it.
  const pick = (a: PickAction) => {
    onPick(a);
    if (a.kind === "item") { onClose(); return; }
    setAdded((x) => [...x, a.name]);
    setPicked(null);
  };

  return (
    <Dialog
      open={open}
      onClose={() => { setAdded([]); onClose(); }}
      xl
      title="Pick elements on the page"
      description="Hover to highlight, click to select. Add as many fields as you like, then press Done."
      footer={<>
        {added.length > 0 && <span className="mr-auto text-sm text-muted">Added: {added.join(", ")}</span>}
        <Button onClick={() => { setAdded([]); onClose(); }}>Done</Button>
      </>}
    >
      {loading && <div className="skeleton h-96 rounded-lg" role="status" aria-label="Loading page" />}
      {error && <ErrorNote title="Could not load the page" message={error} onRetry={load} />}
      {data && !loading && (
        <div className="space-y-4">
          {picked && (
            <div className="space-y-3 rounded-xl border border-accent/40 bg-accent-soft/30 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="accent">{picked.tag}</Badge>
                <span className="min-w-0 flex-1 truncate">{picked.text || picked.src || picked.href}</span>
                {picked.similar > 1 && <Badge>{picked.similar} similar on page</Badge>}
              </div>
              <code className="block truncate rounded bg-surface px-2 py-1 font-mono text-xs">{picked.similar > 1 ? picked.general : picked.selector}</code>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" icon={<ListPlus className="size-4" />} onClick={() => pick({ kind: "field", selector: hasItemSelector ? relativeSelector(picked.general, itemSelector) : picked.selector, attr: picked.tag === "img" ? "src" : "text", multiple: false, name: guessName(picked) })}>
                  Add as field
                </Button>
                {picked.similar > 1 && !hasItemSelector && (
                  <Button size="sm" variant="secondary" icon={<Rows3 className="size-4" />} onClick={() => pick({ kind: "field", selector: picked.general, attr: picked.tag === "img" ? "src" : "text", multiple: true, name: guessName(picked) })}>
                    Add all {picked.similar}
                  </Button>
                )}
                {picked.href && picked.tag !== "img" && (
                  <Button size="sm" variant="secondary" icon={<Link2 className="size-4" />} onClick={() => pick({ kind: "field", selector: hasItemSelector ? relativeSelector(picked.general, itemSelector) : picked.similar > 1 ? picked.general : picked.selector, attr: "href", multiple: !hasItemSelector && picked.similar > 1, name: "link" })}>
                    Add its link
                  </Button>
                )}
                {parentOf(boxes, picked) && (
                  <Button size="sm" variant="ghost" icon={<ArrowUpLeft className="size-4" />} onClick={() => setPicked(parentOf(boxes, picked))}>Select parent</Button>
                )}
                {picked.similar > 1 && (
                  <Button size="sm" variant="secondary" icon={<Crosshair className="size-4" />} onClick={() => pick({ kind: "item", selector: picked.general })}>Use as item ({plural(picked.similar, "row")})</Button>
                )}
              </div>
              <p className="text-xs text-muted">{hasItemSelector ? "Fields are read inside each item. Pick the title, price, link … of one item." : "Tip: click one product card, choose “Use as item” (or “Select parent” until the whole card is outlined), then pick its title and price."}</p>
            </div>
          )}
          <div className="max-h-[60vh] overflow-auto rounded-lg border border-border">
            <div
              className="relative cursor-crosshair"
              onMouseMove={(e) => { const p = toPage(e); setHover(hit(boxes, p.x, p.y)); }}
              onMouseLeave={() => setHover(null)}
              onClick={(e) => { const p = toPage(e); setPicked(hit(boxes, p.x, p.y)); }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- inline base64 screenshot */}
              <img ref={imgRef} src={`data:image/jpeg;base64,${data.screenshot}`} alt={`Screenshot of ${data.title}`} className="block w-full select-none" draggable={false} />
              {similarBoxes.map((b, i) => <Outline key={i} b={b} w={shotWidth} h={data.height} dashed />)}
              {highlight && <Outline b={highlight} w={shotWidth} h={data.height} />}
            </div>
          </div>
          <p className="text-xs text-muted">Keyboard users: type selectors directly in the fields instead. The picker shows the first {Math.round(data.height)}px of the page.</p>
        </div>
      )}
    </Dialog>
  );
}

/** Positioned in percent of the screenshot, so it needs no measurements during render. */
function Outline({ b, w, h, dashed }: { b: Box; w: number; h: number; dashed?: boolean }) {
  return (
    <div
      aria-hidden
      className={dashed ? "pointer-events-none absolute border border-dashed border-accent/70" : "pointer-events-none absolute border-2 border-accent bg-accent/15"}
      style={{ left: `${(b.x / w) * 100}%`, top: `${(b.y / h) * 100}%`, width: `${(b.w / w) * 100}%`, height: `${(b.h / h) * 100}%` }}
    />
  );
}
