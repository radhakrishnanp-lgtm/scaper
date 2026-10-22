import "server-only";
import { createSign } from "node:crypto";
import { fetch as undiciFetch } from "undici";
import type { Cell, Dataset } from "@/lib/types";
import { env } from "../env";
import { dispatcherFor } from "../fetcher/http";
import { addDelivery, recordAttempt } from "../repo/deliveries";
import { getRecipe, getRun } from "../repo/scrapes";
import { getSettings } from "../repo/settings";
import { mainDatasetIndex } from "../tasks/engine";

/**
 * Google Sheets sync with a service account (no browser sign-in): Scaper signs a JWT with the account's key,
 * trades it for an access token, and writes rows with the Sheets API. Share the sheet with the account's email.
 */
type ServiceAccount = { client_email: string; private_key: string };

const g = globalThis as unknown as { __scaperGoogleToken?: { key: string; token: string; expires: number } | null };

export function parseServiceAccount(json: string): ServiceAccount {
  let sa: Partial<ServiceAccount>;
  try { sa = JSON.parse(json) as Partial<ServiceAccount>; } catch { throw new Error("The service account key is not valid JSON. Paste the whole file you downloaded from Google Cloud."); }
  if (!sa.client_email || !sa.private_key) throw new Error("The key is missing client_email or private_key. Download a JSON key for a service account.");
  return { client_email: sa.client_email, private_key: sa.private_key };
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export function signJwt(sa: ServiceAccount, audience: string, nowSec = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: audience, iat: nowSec, exp: nowSec + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;
}

async function accessToken(json: string) {
  const sa = parseServiceAccount(json);
  const cached = g.__scaperGoogleToken;
  if (cached && cached.key === sa.client_email && cached.expires > Date.now() + 60_000) return cached.token;
  const res = await undiciFetch(env.SCAPER_GOOGLE_TOKEN_URL, {
    method: "POST", dispatcher: dispatcherFor(""), signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signJwt(sa, env.SCAPER_GOOGLE_TOKEN_URL) }).toString(),
  });
  const body = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !body.access_token) throw new Error(`Google sign-in failed: ${body.error_description ?? body.error ?? `HTTP ${res.status}`}`);
  g.__scaperGoogleToken = { key: sa.client_email, token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

/** Accepts a spreadsheet ID or its URL (https://docs.google.com/spreadsheets/d/<id>/edit). */
export function spreadsheetId(input: string) {
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(input);
  const id = (m?.[1] ?? input).trim();
  if (!/^[a-zA-Z0-9-_]{10,}$/.test(id)) throw new Error("That doesn't look like a Google Sheets link or ID.");
  return id;
}

async function sheetsApi<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await undiciFetch(`${env.SCAPER_SHEETS_API_URL}${path}`, {
    method, dispatcher: dispatcherFor(""), signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* plain text */ }
    if (res.status === 403 || res.status === 404) msg += " Share the sheet with the service account's email (Editor) and check the link.";
    throw Object.assign(new Error(`Google Sheets: ${msg}`), { status: res.status });
  }
  return (text ? JSON.parse(text) : {}) as T;
}

const quote = (sheet: string) => `'${sheet.replace(/'/g, "''")}'`;
const range = (sheet: string, a1 = "") => encodeURIComponent(`${quote(sheet)}${a1 ? `!${a1}` : ""}`);
const cellOut = (v: Cell | undefined) => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : v);

type Meta = { properties?: { title?: string }; sheets?: { properties?: { title?: string } }[] };

async function ensureSheet(token: string, id: string, sheet: string) {
  const meta = await sheetsApi<Meta>(token, "GET", `/spreadsheets/${id}?fields=properties.title,sheets.properties.title`);
  const titles = (meta.sheets ?? []).map((s) => s.properties?.title ?? "");
  if (!titles.includes(sheet)) await sheetsApi(token, "POST", `/spreadsheets/${id}:batchUpdate`, { requests: [{ addSheet: { properties: { title: sheet } } }] });
  return { title: meta.properties?.title ?? "", sheets: titles.includes(sheet) ? titles : [...titles, sheet] };
}

/** Settings → Test: signs in and reads the spreadsheet's name. */
export async function testSheet(spreadsheet: string, json = getSettings().integrations.googleServiceAccount) {
  if (!json) throw new Error("Add a service account key first.");
  const token = await accessToken(json);
  const meta = await sheetsApi<Meta>(token, "GET", `/spreadsheets/${spreadsheetId(spreadsheet)}?fields=properties.title,sheets.properties.title`);
  return { title: meta.properties?.title ?? "", sheets: (meta.sheets ?? []).map((s) => s.properties?.title ?? "") };
}

export type SyncOptions = { spreadsheet: string; sheet: string; mode: "append" | "upsert" | "replace"; keyFields: string[] };

/**
 * Writes a dataset to a sheet. Replace: the sheet becomes these rows. Append: rows are added under the
 * existing ones (new columns are added to the header). Upsert: rows with the same key are updated in place,
 * new keys are appended, so the sheet always holds the latest value of every item.
 */
export async function syncDataset(ds: Dataset, o: SyncOptions, json = getSettings().integrations.googleServiceAccount) {
  if (!json) throw new Error("Add a Google service account key in Integrations → Google Sheets first.");
  const token = await accessToken(json);
  const id = spreadsheetId(o.spreadsheet);
  await ensureSheet(token, id, o.sheet);
  const columns = ds.columns;
  if (o.mode === "replace") {
    await sheetsApi(token, "POST", `/spreadsheets/${id}/values/${range(o.sheet)}:clear`, {});
    await sheetsApi(token, "PUT", `/spreadsheets/${id}/values/${range(o.sheet, "A1")}?valueInputOption=RAW`, { values: [columns, ...ds.rows.map((r) => columns.map((c) => cellOut(r[c])))] });
    return { added: ds.rows.length, updated: 0, columns: columns.length };
  }
  const existing = (await sheetsApi<{ values?: (string | number | boolean)[][] }>(token, "GET", `/spreadsheets/${id}/values/${range(o.sheet)}?valueRenderOption=UNFORMATTED_VALUE`)).values ?? [];
  const header = (existing[0] ?? []).map((h) => String(h));
  const added = columns.filter((c) => !header.includes(c));
  const fullHeader = [...header, ...added];
  if (!header.length || added.length) await sheetsApi(token, "PUT", `/spreadsheets/${id}/values/${range(o.sheet, "A1")}?valueInputOption=RAW`, { values: [fullHeader] });
  const toRow = (r: Record<string, Cell>) => fullHeader.map((c) => cellOut(r[c]));

  let updates: { range: string; values: (string | number | boolean)[][] }[] = [];
  let fresh = ds.rows;
  if (o.mode === "upsert") {
    const keys = (o.keyFields.length ? o.keyFields : columns.filter((c) => /link|url|id|sku|asin/i.test(c)).slice(0, 1)).filter((k) => fullHeader.includes(k));
    if (!keys.length) throw new Error("Choose key fields for upsert (the columns that identify an item, like its link).");
    const idx = keys.map((k) => fullHeader.indexOf(k));
    const rowOf = new Map<string, number>();
    existing.slice(1).forEach((row, i) => rowOf.set(JSON.stringify(idx.map((j) => String(row[j] ?? ""))), i + 2));
    fresh = [];
    for (const r of ds.rows) {
      const n = rowOf.get(JSON.stringify(keys.map((k) => String(cellOut(r[k])))));
      if (n) updates.push({ range: `${quote(o.sheet)}!A${n}`, values: [toRow(r)] });
      else fresh.push(r);
    }
    for (let i = 0; i < updates.length; i += 500) {
      await sheetsApi(token, "POST", `/spreadsheets/${id}/values:batchUpdate`, { valueInputOption: "RAW", data: updates.slice(i, i + 500) });
    }
  }
  if (fresh.length) {
    await sheetsApi(token, "POST", `/spreadsheets/${id}/values/${range(o.sheet, "A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: fresh.map(toRow) });
  }
  const updated = updates.length;
  updates = [];
  return { added: fresh.length, updated, columns: fullHeader.length };
}

/** Background job after a task run: copies the run's main dataset to the task's sheet, logged as a delivery. */
export async function syncRunToSheet(runId: string, hooks: { log?: (l: "info" | "warn", m: string) => void } = {}) {
  const run = getRun(runId);
  if (!run?.result || !run.recipe_id) throw new Error("The run has no data.");
  const task = getRecipe(run.recipe_id);
  if (!task) throw new Error("This task was deleted.");
  const o = task.options.output.sheets;
  const ds = run.result.datasets[mainDatasetIndex(run.result.datasets)];
  if (!ds) throw new Error("The run has no data.");
  const keyFields = o.keyFields.length ? o.keyFields : task.options.monitor.keyFields.length ? task.options.monitor.keyFields : task.options.dedupeBy;
  const deliveryId = addDelivery({
    kind: "sheets", target: spreadsheetSafeId(o.spreadsheet), targetName: `${o.sheet} · ${task.name}`, event: `sheets.${o.mode}`,
    url: o.spreadsheet, payload: { spreadsheet: o.spreadsheet, sheet: o.sheet, mode: o.mode, rows: ds.rows.length, columns: ds.columns, runId }, refId: task.id,
  });
  const t0 = Date.now();
  try {
    const out = await syncDataset(ds, { spreadsheet: o.spreadsheet, sheet: o.sheet, mode: o.mode, keyFields });
    recordAttempt(deliveryId, { status: "ok", code: 200, body: JSON.stringify(out), ms: Date.now() - t0 });
    hooks.log?.("info", `Google Sheets: ${out.added} row(s) added, ${out.updated} updated in "${o.sheet}".`);
    return { ...out, deliveryId };
  } catch (e) {
    const err = e as Error & { status?: number };
    recordAttempt(deliveryId, { status: "failed", code: err.status ?? null, error: err.message, ms: Date.now() - t0 });
    throw e;
  }
}

function spreadsheetSafeId(s: string) {
  try { return spreadsheetId(s); } catch { return s.slice(0, 80); }
}
