import type { ConditionInput as Condition } from "@/lib/schemas";

export type CheckState = { content: string; value: number | null; inStock?: boolean | null };
export type ChangeInfo = { changed: boolean; addedText: string; removedText: string };

/** "state" conditions alert once when they become true; "event" conditions alert each time they happen. */
export type Evaluation = { met: boolean; notify: boolean; reason: string; kind: "state" | "event" };

const fmt = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

function scoped(c: { scope?: "all" | "added" | "removed" }, cur: CheckState, change: ChangeInfo) {
  if (c.scope === "added") return change.addedText;
  if (c.scope === "removed") return change.removedText;
  return cur.content;
}
const scopeLabel = (s?: string) => (s === "added" ? " in the added lines" : s === "removed" ? " in the removed lines" : "");

/**
 * Decides whether one condition fires for this check.
 * `prevMet` is whether the same condition was true at the previous check.
 * The AI condition is decided separately (it needs a model call) and passed in as `aiVerdict`.
 */
export function evaluate(
  condition: Condition,
  prev: (CheckState & { met: boolean }) | null,
  cur: CheckState,
  change: ChangeInfo | boolean,
  aiVerdict?: { match: boolean; reason: string },
): Evaluation {
  const ch: ChangeInfo = typeof change === "boolean" ? { changed: change, addedText: "", removedText: "" } : change;
  const changed = ch.changed;
  switch (condition.type) {
    case "any_change":
      return { met: changed, notify: changed && prev !== null, reason: "The watched content changed.", kind: "event" };
    case "contains":
    case "not_contains":
    case "regex": {
      const text = scoped(condition, cur, ch);
      const hit = condition.type === "regex" ? safeRegex(condition.pattern ?? "").test(text) : text.toLowerCase().includes(condition.text.toLowerCase());
      const label = condition.type === "regex" ? `/${condition.pattern}/` : `"${condition.text}"`;
      if (condition.scope && condition.scope !== "all") {
        const met = changed && (condition.type === "not_contains" ? !hit : hit);
        const verb = condition.type === "not_contains" ? "is not" : "appeared";
        return { met, notify: met && prev !== null, reason: `${label} ${verb}${scopeLabel(condition.scope)}.`, kind: "event" };
      }
      const met = condition.type === "not_contains" ? !hit : hit;
      const reason = condition.type === "not_contains" ? `${label} is no longer on the page.` : condition.type === "regex" ? `The page now matches ${label}.` : `The page now contains ${label}.`;
      return { met, notify: met && !prev?.met, reason, kind: "state" };
    }
    case "below": {
      const met = cur.value !== null && cur.value < condition.value;
      return { met, notify: met && !prev?.met, reason: `Value ${cur.value !== null ? fmt(cur.value) : "?"} is below ${fmt(condition.value)}.`, kind: "state" };
    }
    case "above": {
      const met = cur.value !== null && cur.value > condition.value;
      return { met, notify: met && !prev?.met, reason: `Value ${cur.value !== null ? fmt(cur.value) : "?"} is above ${fmt(condition.value)}.`, kind: "state" };
    }
    case "drop_percent":
    case "rise_percent": {
      if (!prev || prev.value === null || cur.value === null || prev.value <= 0) return { met: false, notify: false, reason: "", kind: "event" };
      const delta = ((cur.value - prev.value) / prev.value) * 100;
      const met = condition.type === "drop_percent" ? -delta >= condition.percent : delta >= condition.percent;
      const word = condition.type === "drop_percent" ? "Dropped" : "Rose";
      return { met, notify: met, reason: `${word} ${Math.abs(delta).toFixed(1)}% (from ${fmt(prev.value)} to ${fmt(cur.value)}).`, kind: "event" };
    }
    case "in_stock": {
      const met = cur.inStock === true || (cur.inStock === undefined && /\b(in stock|add to cart|buy now)\b/i.test(cur.content) && !/out of stock|currently unavailable|sold out/i.test(cur.content));
      return { met, notify: met && prev !== null && !prev.met, reason: "Back in stock.", kind: "state" };
    }
    case "ai": {
      const met = changed && Boolean(aiVerdict?.match);
      return { met, notify: met && prev !== null, reason: aiVerdict?.reason || "The AI judged this change relevant.", kind: "event" };
    }
  }
}

function safeRegex(pattern: string) {
  try { return new RegExp(pattern, "i"); } catch { return /$^/; }
}

/**
 * Combines several conditions. "all": every condition must hold, and the alert fires when the
 * combination becomes true (or, if it includes event conditions, when those events happen).
 * "any": the alert fires when any one condition fires.
 */
export function combine(evals: Evaluation[], match: "all" | "any", prevCombinedMet: boolean): Evaluation {
  if (evals.length === 1) return evals[0]!;
  if (match === "any") {
    const firing = evals.filter((e) => e.notify);
    return { met: evals.some((e) => e.met), notify: firing.length > 0, reason: (firing.length ? firing : evals.filter((e) => e.met)).map((e) => e.reason).filter(Boolean).join(" "), kind: "event" };
  }
  const met = evals.every((e) => e.met);
  const events = evals.filter((e) => e.kind === "event");
  const notify = met && (events.length ? events.every((e) => e.notify) : !prevCombinedMet);
  return { met, notify, reason: evals.map((e) => e.reason).filter(Boolean).join(" "), kind: events.length ? "event" : "state" };
}
