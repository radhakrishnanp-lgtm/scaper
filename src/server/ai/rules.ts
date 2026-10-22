import "server-only";
import { z } from "zod";
import { VALIDATION_CHECKS, VALUE_TYPES, validationRuleSchema, type ValidationRule } from "@/lib/schemas";
import type { Dataset } from "@/lib/types";
import { profileDataset, suggestRules } from "@/lib/validation";
import { chat, parseJsonReply } from "./client";
import { UNTRUSTED_NOTE } from "./extract";

const replySchema = z.object({ rules: z.array(z.record(z.string(), z.unknown())).max(40) });
const id = () => Math.random().toString(36).slice(2, 10);

/**
 * Data checks written by your AI from a good run (Kadoa-style): it sees each column's profile and sample
 * rows and proposes expectations a broken run would violate. Invalid suggestions are dropped; the result
 * is merged with the rules Scaper derives from the data itself.
 */
export async function suggestRulesWithAi(ds: Dataset, context: { name: string; description?: string; keyFields?: string[] }) {
  const base = suggestRules(ds, { keyFields: context.keyFields });
  const profiles = profileDataset(ds).map((p) => ({
    column: p.column, type: p.type, fill: p.fill, distinct: p.distinct, unique: p.unique, min: p.min, max: p.max,
    minLength: p.minLength, maxLength: p.maxLength, top: p.top.slice(0, 5).map((t) => t.value.slice(0, 60)),
  }));
  const sample = ds.rows.slice(0, 12).map((r) => Object.fromEntries(ds.columns.map((c) => [c, typeof r[c] === "string" ? (r[c] as string).slice(0, 120) : r[c]])));
  const res = await chat([
    {
      role: "system",
      content: `You write data-quality checks for a web scraping task, so a run where the site changed and the data broke is caught. Reply with JSON {"rules": [...]}.
Each rule: {"column": "<column name, or * for the whole run>", "check": one of ${VALIDATION_CHECKS.join(", ")}, "arg": "...", "min": number|null, "max": number|null, "mostly": 1-100, "severity": "warn"|"fail", "note": "why, in a few words"}.
- pattern: arg is a JavaScript regular expression. one_of: arg lists allowed values separated by |. type: arg is one of ${VALUE_TYPES.join(", ")}.
- range and length use min/max. row_count uses column "*" and min/max. duplicates uses column "*" and max as a percentage.
- Use "mostly" below 100 where a few odd rows are normal. Use "fail" only for checks that mean the data is broken.
- Prefer 5 to 12 precise checks. Don't repeat what the column profile can't support. ${UNTRUSTED_NOTE}`,
    },
    { role: "user", content: `Task: ${context.name}${context.description ? ` — ${context.description.slice(0, 300)}` : ""}\nRows in this run: ${ds.rows.length}\n<page>\nCOLUMNS:\n${JSON.stringify(profiles)}\n\nSAMPLE ROWS:\n${JSON.stringify(sample)}\n</page>` },
  ], { model: "fast", json: true, temperature: 0, maxTokens: 1500, purpose: "rules" });
  const parsed = replySchema.safeParse(parseJsonReply(res.content));
  const ai: ValidationRule[] = [];
  const dropped: string[] = [];
  for (const raw of parsed.success ? parsed.data.rules : []) {
    const r = validationRuleSchema.safeParse({ ...raw, id: id(), enabled: true });
    if (!r.success) { dropped.push(String(raw.column ?? "?")); continue; }
    if (r.data.column !== "*" && !ds.columns.includes(r.data.column)) { dropped.push(r.data.column); continue; }
    ai.push(r.data);
  }
  const key = (r: ValidationRule) => `${r.column}|${r.check}`;
  const seen = new Set(ai.map(key));
  return { rules: [...ai, ...base.filter((r) => !seen.has(key(r)))], fromAi: ai.length, dropped };
}
