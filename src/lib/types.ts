/** Plain data shapes shared by API responses and the UI. */
import type { ValidationReport } from "./validation";

export type Cell = string | number | boolean | null;

export type Dataset = { name: string; columns: string[]; rows: Record<string, Cell>[] };

export type ScrapeResult = {
  title: string;
  finalUrl: string;
  datasets: Dataset[];
  meta: Record<string, Cell>;
  screenshot?: string;
  notes: string[];
  /** Selector suggestions from Auto mode, ready to load into the selector builder. */
  suggestions?: { itemSelector: string; count: number; fields: { name: string; selector: string; attr: string }[] }[];
  /** One entry per page a multi-page task visited. */
  pages?: PageLog[];
  /** Compared with the previous run of the same task. */
  monitor?: { added: number; removed: number; addedRows: Record<string, Cell>[]; removedRows: Record<string, Cell>[] };
  /** Files written to data/exports for this run. */
  files?: string[];
  /** Share of rows with a value, per column, plus anything that looks broken. */
  quality?: { fill: Record<string, number>; issues: string[] };
  /** The task's validation rules checked against this run. */
  validation?: ValidationReport & { opened?: number; resolved?: number };
  /** What went wrong and what to do next, when the run failed or its data looks off. */
  diagnosis?: Diagnosis;
  /** Usual row count for this task (from recent good runs), when there's enough history. */
  expected?: { low: number; high: number; median: number } | null;
};

/** A failure report: the cause in plain words, the evidence, and the one next step most likely to fix it. */
export type Diagnosis = {
  code: string;
  area: "site" | "setup" | "data" | "scaper";
  severity: "error" | "warning";
  title: string;
  detail: string;
  action?: { kind: DiagnosisAction; label: string };
  /** Screenshot of the page as Scaper saw it (media path), when the browser was used. */
  screenshot?: string | null;
  httpStatus?: number | null;
  /** The start of the page text, to show what the site actually returned. */
  excerpt?: string;
  url?: string | null;
};
export type DiagnosisAction = "heal" | "picker" | "steps" | "site" | "browser" | "retry" | "edit" | "quality" | "limits" | "setup";

export type PageLog = { url: string; status: "ok" | "error" | "blocked" | "skipped"; rows: number; ms: number; depth: number; error?: string };

export type ApiError = { error: { code: string; message: string; requestId: string; fields?: Record<string, string> } };
