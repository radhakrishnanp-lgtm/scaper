/** Plain data shapes shared by API responses and the UI. */

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
};

export type PageLog = { url: string; status: "ok" | "error" | "blocked" | "skipped"; rows: number; ms: number; depth: number; error?: string };

export type ApiError = { error: { code: string; message: string; requestId: string; fields?: Record<string, string> } };
