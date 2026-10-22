import { describe, expect, it } from "vitest";
import { lineDiff, splitRows, unifiedRows, wordDiff } from "@/lib/diff";

describe("change viewer diff", () => {
  it("marks added and removed lines with line numbers", () => {
    const ops = lineDiff("a\nb\nc", "a\nB\nc\nd");
    expect(ops.map((o) => `${o.op}${o.text}`)).toEqual([" a", "-b", "+B", " c", "+d"]);
    expect(ops.find((o) => o.text === "d")).toMatchObject({ a: null, b: 4 });
    expect(ops.find((o) => o.text === "c")).toMatchObject({ a: 3, b: 3 });
  });

  it("finds the words that changed inside a line", () => {
    const w = wordDiff("Price: 1,999 in stock", "Price: 1,799 in stock");
    expect(w.before.filter((s) => s.changed).map((s) => s.text).join("")).toBe("999");
    expect(w.after.filter((s) => s.changed).map((s) => s.text).join("")).toBe("799");
  });

  it("collapses long unchanged runs and expands them on request", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 15", "line fifteen");
    const ops = lineDiff(before, after);
    const rows = unifiedRows(ops, 2);
    const gaps = rows.filter((r) => r.kind === "gap");
    expect(gaps).toHaveLength(2);
    expect(rows.filter((r) => r.kind === "line")).toHaveLength(6);
    const first = gaps[0]!;
    if (first.kind !== "gap") throw new Error("expected gap");
    const opened = unifiedRows(ops, 2, new Set([first.from]));
    expect(opened.filter((r) => r.kind === "gap")).toHaveLength(1);
    expect(unifiedRows(ops, null)).toHaveLength(ops.length);
  });

  it("puts replaced lines side by side", () => {
    const rows = splitRows(lineDiff("x\nold one\ny", "x\nnew one\ny"), null);
    const changed = rows.find((r) => r.kind === "pair" && r.left?.op === "-");
    expect(changed).toMatchObject({ left: { text: "old one" }, right: { text: "new one" } });
  });

  it("handles identical and empty texts", () => {
    expect(lineDiff("same", "same").every((o) => o.op === " ")).toBe(true);
    expect(lineDiff("", "new").map((o) => o.op)).toEqual(["-", "+"]);
  });
});
