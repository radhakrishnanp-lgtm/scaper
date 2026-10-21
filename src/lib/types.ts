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
};

export type ApiError = { error: { code: string; message: string; requestId: string; fields?: Record<string, string> } };
