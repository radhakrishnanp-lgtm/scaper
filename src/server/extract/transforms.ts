import type { Transform } from "@/lib/schemas";
import type { Cell } from "@/lib/types";
import { parsePrice } from "./price";

const MAX_INPUT = 20_000;

function toNumber(s: string): number | null {
  const p = parsePrice(s);
  if (p) return p.value;
  const m = /-?\d[\d,]*(\.\d+)?/.exec(s);
  if (!m) return null;
  const v = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
}

/** Applies a field's clean-up steps in order. Values stay strings unless a "number" step runs. */
export function applyTransforms(value: Cell, transforms: Transform[], base: string): Cell {
  let v: Cell = value;
  for (const t of transforms) {
    if (t.op === "default") {
      if (v === null || v === "") v = t.value;
      continue;
    }
    if (v === null) continue;
    const s = String(v).slice(0, MAX_INPUT);
    switch (t.op) {
      case "trim": v = s.replace(/\s+/g, " ").trim(); break;
      case "lower": v = s.toLowerCase(); break;
      case "upper": v = s.toUpperCase(); break;
      case "number": v = toNumber(s); break;
      case "stripHtml": v = s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); break;
      case "absoluteUrl": try { v = new URL(s, base).toString(); } catch { /* keep as is */ } break;
      case "regex": {
        const m = new RegExp(t.pattern, "i").exec(s);
        v = m ? (m[t.group] ?? m[0]) ?? null : null;
        break;
      }
      case "replace":
        v = t.regex ? s.replace(new RegExp(t.find, "g"), t.with) : s.split(t.find).join(t.with);
        break;
      case "prefix": v = t.value + s; break;
      case "suffix": v = s + t.value; break;
      case "split": {
        const parts = s.split(t.separator);
        v = (t.index < 0 ? parts[parts.length + t.index] : parts[t.index])?.trim() ?? null;
        break;
      }
    }
  }
  return v === "" ? null : v;
}
