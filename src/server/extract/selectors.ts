import type { Field } from "@/lib/schemas";
import type { Cell, Dataset } from "@/lib/types";
import { load, readValue, safeSelect, type $, type Sel } from "./dom";
import { parsePrice } from "./price";

const MAX_ROWS = 1000;

function fieldValue($: $, scope: Sel | null, f: Field, base: string): Cell | Cell[] {
  const matches = f.selector === ":scope" && scope ? scope : safeSelect($, f.selector, scope ?? undefined);
  if (f.multiple) return matches.toArray().slice(0, MAX_ROWS).map((el) => readValue($, $(el), f.attr, base));
  return readValue($, matches.first(), f.attr, base);
}

/** Adds a numeric companion column for fields named like prices, so they sort and chart correctly. */
function withNumbers(row: Record<string, Cell>) {
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "string" && /price|cost|amount|mrp/i.test(k)) row[`${k}_value`] = parsePrice(v)?.value ?? null;
  }
  return row;
}

/**
 * Two ways to use selectors:
 * - with an item selector: one row per matching item, fields are relative to it;
 * - without: fields are read from the whole page, and "multiple" fields are zipped into rows.
 */
export function extractWithSelectors(html: string, base: string, spec: { itemSelector?: string; fields: Field[] }): Dataset {
  const $ = load(html);
  const columns = spec.fields.map((f) => f.name);
  const rows: Record<string, Cell>[] = [];

  if (spec.itemSelector) {
    safeSelect($, spec.itemSelector).slice(0, MAX_ROWS).each((_, el) => {
      const item = $(el);
      const row: Record<string, Cell> = {};
      for (const f of spec.fields) {
        const v = fieldValue($, item, f, base);
        row[f.name] = Array.isArray(v) ? v.filter(Boolean).join(" | ") || null : v;
      }
      if (Object.values(row).some((v) => v !== null && v !== "")) rows.push(withNumbers(row));
    });
  } else {
    const values = spec.fields.map((f) => fieldValue($, null, f, base));
    const height = Math.max(1, ...values.map((v) => (Array.isArray(v) ? v.length : 1)));
    for (let i = 0; i < Math.min(height, MAX_ROWS); i++) {
      const row: Record<string, Cell> = {};
      spec.fields.forEach((f, idx) => {
        const v = values[idx]!;
        row[f.name] = Array.isArray(v) ? (v[i] ?? null) : i === 0 ? v : null;
      });
      rows.push(withNumbers(row));
    }
  }
  const allColumns = [...new Set([...columns, ...rows.flatMap((r) => Object.keys(r))])];
  return { name: "Selected fields", columns: allColumns, rows };
}

/** Counts matches for a selector, for live feedback in the selector builder. */
export function testSelector(html: string, base: string, selector: string, attr = "text") {
  const $ = load(html);
  const m = safeSelect($, selector);
  return { count: m.length, samples: m.toArray().slice(0, 5).map((el) => readValue($, $(el), attr, base)) };
}
