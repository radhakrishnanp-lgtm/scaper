import "server-only";
import type { Element } from "domhandler";
import { z } from "zod";
import type { Cell } from "@/lib/types";
import { findRepeatedGroups } from "../extract/auto";
import { clean, load } from "../extract/dom";
import { extractWithSelectors } from "../extract/selectors";
import { AiError, chat, parseJsonReply, type ModelChoice } from "./client";
import { UNTRUSTED_NOTE } from "./extract";

const MAX_OUTLINE = 16_000;
const SKIP = new Set(["script", "style", "noscript", "template", "svg", "iframe", "link", "meta", "head", "path"]);

/**
 * A compact outline of the page for the model: tag, id, classes and a little text per element,
 * indented by depth. Enough to pick selectors without sending the whole HTML.
 */
export function pageOutline(html: string, maxChars = MAX_OUTLINE) {
  const $ = load(html);
  const lines: string[] = [];
  let size = 0;
  const walk = (el: Element, depth: number) => {
    if (size > maxChars || depth > 40 || SKIP.has(el.tagName)) return;
    const id = el.attribs.id ? `#${el.attribs.id}` : "";
    const cls = (el.attribs.class ?? "").split(/\s+/).filter((c) => c && c.length < 40).slice(0, 4).map((c) => `.${c}`).join("");
    const own = clean(el.children.filter((c) => c.type === "text").map((c) => (c as unknown as { data: string }).data).join(" ")).slice(0, 60);
    const attrs = ["href", "src", "datetime", "data-price", "itemprop", "aria-label"].filter((a) => el.attribs[a]).map((a) => `${a}=${el.attribs[a]!.slice(0, 40)}`).join(" ");
    const kids = el.children.filter((c): c is Element => c.type === "tag" && !SKIP.has(c.tagName));
    // Collapse wrappers with no identity or text to keep the outline short.
    if (!id && !cls && !own && !attrs && kids.length === 1 && depth > 2) return walk(kids[0]!, depth);
    const line = `${"  ".repeat(Math.min(depth, 20))}${el.tagName}${id}${cls}${attrs ? ` [${attrs}]` : ""}${own ? ` "${own}"` : ""}`;
    lines.push(line);
    size += line.length + 1;
    // For long lists, show the first few items in full and just count the rest.
    let shown = 0;
    let lastSig = "";
    let repeats = 0;
    for (const k of kids) {
      const sig = `${k.tagName}.${k.attribs.class ?? ""}`;
      repeats = sig === lastSig ? repeats + 1 : 0;
      lastSig = sig;
      if (repeats >= 3) { shown++; continue; }
      walk(k, depth + 1);
    }
    if (shown) { lines.push(`${"  ".repeat(Math.min(depth + 1, 20))}… ${shown} more similar ${lastSig.split(".")[0]} elements`); size += 40; }
  };
  const body = $("body")[0] as Element | undefined;
  if (body) walk(body, 0);
  const text = lines.join("\n");
  return text.length > maxChars ? text.slice(0, maxChars) + "\n[truncated]" : text;
}

const replySchema = z.object({
  itemSelector: z.string().max(500).default(""),
  fields: z.array(z.object({
    name: z.string().trim().min(1).max(60).transform((n) => n.replace(/[^\w\- ]+/g, "_").slice(0, 60) || "field"),
    selector: z.string().trim().min(1).max(500),
    attr: z.string().trim().max(60).default("text"),
  })).min(1).max(30),
  note: z.string().max(400).optional(),
});

export type Suggestion = {
  itemSelector: string;
  fields: { name: string; selector: string; attr: string }[];
  rows: Record<string, Cell>[];
  count: number;
  note: string | null;
  attempts: number;
};

/**
 * "Build with AI": turns a plain description ("product name, price and link for each card")
 * into an item selector and fields. The model only proposes selector strings; every proposal is
 * parsed and tried against the page here, and the user sees the preview before saving anything.
 */
export async function suggestSelectors(html: string, url: string, describe: string, model: ModelChoice = "fast"): Promise<Suggestion> {
  const outline = pageOutline(html);
  const hints = findRepeatedGroups(load(html), url, 3).map((g) => `- ${g.itemSelector} (${g.count} items)`).join("\n");
  const messages: Parameters<typeof chat>[0] = [
    {
      role: "system",
      content:
        "You write CSS selectors for a web scraper. Reply with JSON only: " +
        '{"itemSelector": "<selector for each repeated item, or empty for single values>", "fields": [{"name": "snake_case", "selector": "<CSS relative to the item>", "attr": "text|html|href|src|<attribute>"}], "note": "<one short sentence>"}. ' +
        "Use standard CSS only (no :contains, no XPath). Prefer stable classes and ids over position. Use \":scope\" to read the item itself. " +
        UNTRUSTED_NOTE,
    },
    {
      role: "user",
      content: `I want: ${describe}\nPage URL: ${url}\n${hints ? `Repeated lists Scaper already found:\n${hints}\n` : ""}<page>\n${outline}\n</page>`,
    },
  ];
  let best: Suggestion | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await chat(messages, { model, json: true, temperature: 0, purpose: "selectors", cache: attempt === 1 });
    const parsed = replySchema.safeParse(parseJsonReply(res.content));
    if (!parsed.success) {
      if (attempt === 2) break;
      messages.push({ role: "assistant", content: res.content.slice(0, 2000) }, { role: "user", content: "That was not the JSON shape asked for. Reply with the JSON object only." });
      continue;
    }
    const { itemSelector, fields, note } = parsed.data;
    let rows: Record<string, Cell>[] = [];
    let problem = "";
    try {
      rows = extractWithSelectors(html, url, { itemSelector, fields }).rows;
      if (!rows.length) problem = itemSelector ? `The item selector "${itemSelector}" matched no items with values.` : "None of the field selectors matched anything.";
    } catch (e) {
      problem = (e as Error).message;
    }
    const filled = fields.map((f) => rows.filter((r) => r[f.name] !== null && r[f.name] !== "").length);
    const empty = fields.filter((_, i) => rows.length && filled[i] === 0).map((f) => f.name);
    if (!problem && empty.length) problem = `These fields came out empty on every row: ${empty.join(", ")}.`;
    const current: Suggestion = { itemSelector, fields, rows: rows.slice(0, 10), count: rows.length, note: problem || note || null, attempts: attempt };
    if (!best || current.count > best.count || (current.count === best.count && !problem)) best = current;
    if (!problem) return current;
    if (attempt === 2) break;
    messages.push({ role: "assistant", content: JSON.stringify(parsed.data) }, { role: "user", content: `I tried it on the page. ${problem} Fix the selectors and reply with the full JSON again.` });
  }
  if (!best) throw new AiError("bad_output", "The AI did not return usable selectors. Try describing the data differently, or use the picker.");
  return best;
}
