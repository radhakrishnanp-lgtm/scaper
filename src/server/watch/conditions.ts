import type { Condition } from "@/lib/schemas";

export type CheckState = { content: string; value: number | null };

export type Evaluation = { met: boolean; notify: boolean; reason: string };

const fmt = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

/**
 * Decides whether a check should alert.
 * "State" conditions (contains, below ...) alert once when they become true, not on every check.
 * "Event" conditions (any change, price drop) alert each time they happen.
 * The AI condition is decided separately (it needs a model call) and passed in as `aiVerdict`.
 */
export function evaluate(
  condition: Condition,
  prev: (CheckState & { met: boolean }) | null,
  cur: CheckState,
  changed: boolean,
  aiVerdict?: { match: boolean; reason: string },
): Evaluation {
  const lower = cur.content.toLowerCase();
  switch (condition.type) {
    case "any_change":
      return { met: changed, notify: changed && prev !== null, reason: "The watched content changed." };
    case "contains": {
      const met = lower.includes(condition.text.toLowerCase());
      return { met, notify: met && !prev?.met, reason: `The page now contains "${condition.text}".` };
    }
    case "not_contains": {
      const met = !lower.includes(condition.text.toLowerCase());
      return { met, notify: met && !prev?.met, reason: `"${condition.text}" is no longer on the page.` };
    }
    case "below": {
      const met = cur.value !== null && cur.value < condition.value;
      return { met, notify: met && !prev?.met, reason: `Value ${cur.value !== null ? fmt(cur.value) : "?"} is below ${fmt(condition.value)}.` };
    }
    case "above": {
      const met = cur.value !== null && cur.value > condition.value;
      return { met, notify: met && !prev?.met, reason: `Value ${cur.value !== null ? fmt(cur.value) : "?"} is above ${fmt(condition.value)}.` };
    }
    case "drop_percent": {
      if (!prev || prev.value === null || cur.value === null || prev.value <= 0) return { met: false, notify: false, reason: "" };
      const drop = ((prev.value - cur.value) / prev.value) * 100;
      const met = drop >= condition.percent;
      return { met, notify: met, reason: `Dropped ${drop.toFixed(1)}% (from ${fmt(prev.value)} to ${fmt(cur.value)}).` };
    }
    case "ai": {
      const met = changed && Boolean(aiVerdict?.match);
      return { met, notify: met && prev !== null, reason: aiVerdict?.reason || "The AI judged this change relevant." };
    }
  }
}
