import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { fetch as undiciFetch } from "undici";
import type { Dataset } from "@/lib/types";
import { bus } from "../bus";
import { env } from "../env";
import { DEFAULT_FAST_UA, FetchError, preflight } from "../fetcher";
import { dispatcherFor } from "../fetcher/http";
import { withHostTurn } from "../fetcher/politeness";
import { log } from "../log";
import {
  addDownloads, claimNextDownload, getDownload, requeueInterruptedDownloads, setDownloadStatus, updateDownload,
  type Download, type DownloadSource,
} from "../repo/downloads";
import { audit } from "../repo/events";
import type { ScrapeRun } from "../repo/scrapes";
import { getSettings } from "../repo/settings";

/**
 * The download manager: files from links you add, from task columns (images, videos, PDFs) and from the agent.
 * Each file is a row with progress. Downloads go a few at a time, take turns per site like every other request
 * (network guard, site rules and robots.txt included), keep a .part file, and resume with an HTTP Range request
 * after a pause, a network error or a restart when the server allows it.
 */

const MAX_ATTEMPTS = 4;
const MAX_REDIRECTS = 5;

type State = { running: Map<string, { ctrl: AbortController; reason: "pause" | "cancel" | null }>; pumping: boolean; recovered: boolean };
const g = globalThis as unknown as { __scaperDownloads?: State };
const state: State = (g.__scaperDownloads ??= { running: new Map(), pumping: false, recovered: false });

export const downloadsRoot = () => path.join(env.dataDir, "downloads");

/** A safe folder below the downloads folder: letters, digits, spaces, dots, dashes; at most two levels. */
export function safeFolder(folder: string) {
  return folder.split(/[\\/]+/).map((p) => p.trim().replace(/[^\w .-]+/g, "-").replace(/^\.+/, "").slice(0, 60)).filter(Boolean).slice(0, 2).join("/");
}

const EXT: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif", "image/svg+xml": ".svg",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/ogg": ".ogg",
  "application/pdf": ".pdf", "application/zip": ".zip", "text/csv": ".csv", "application/json": ".json", "text/plain": ".txt",
};

/** A file name from the link: its last path segment, cleaned, or "download". */
export function nameFromUrl(url: string) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
    return cleanName(last) || "download";
  } catch { return "download"; }
}
const cleanName = (n: string) => n.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-").replace(/^\.+/, "").trim().slice(0, 140);

function nameFromHeaders(res: { headers: { get(n: string): string | null } }, fallback: string) {
  const cd = res.headers.get("content-disposition") ?? "";
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(cd)?.[1];
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd)?.[1];
  let name = cleanName(star ? decodeURIComponent(star.replace(/"/g, "")) : plain ?? "") || fallback;
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!path.extname(name) && EXT[type]) name += EXT[type];
  return name;
}

/** A path inside the folder that does not overwrite another file: name.ext, name (2).ext … */
async function freePath(dir: string, name: string) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const p = path.join(dir, i === 1 ? name : `${base} (${i})${ext}`);
    try { await fsp.access(p); } catch { return p; }
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

function emit(id: string) {
  const d = getDownload(id);
  if (d) bus.emit({ type: "download", id, status: d.status, bytes: d.bytes, total: d.total_bytes, name: d.file_name });
}

/** Queue links for download. Returns the ids added and how many were already there. */
export function queueDownloads(urls: string[], opts: { folder?: string; source: DownloadSource; refId?: string | null }) {
  const folder = safeFolder(opts.folder ?? "");
  const clean = [...new Set(urls.map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u)))];
  const out = addDownloads(clean.map((url) => ({ url, folder, fileName: nameFromUrl(url) })), opts.source, opts.refId ?? null);
  if (out.added.length) {
    audit("downloads.added", { count: out.added.length, skipped: out.skipped, source: opts.source });
    queueMicrotask(pumpDownloads);
  }
  return { ...out, invalid: urls.filter((u) => !/^https?:\/\//i.test(u.trim())).length };
}

/** After a task run: queue the files linked in the chosen columns of its main dataset. */
export function runTaskDownloads(run: ScrapeRun, o: { columns: string[]; folder: string; maxFiles: number }, taskName: string) {
  const ds: Dataset | undefined = run.result?.datasets.find((d) => d.columns.some((c) => o.columns.includes(c)));
  if (!ds) return 0;
  const urls: string[] = [];
  for (const r of ds.rows) {
    for (const c of o.columns) {
      const v = r[c];
      if (typeof v === "string" && /^https?:\/\//i.test(v)) urls.push(v);
    }
    if (urls.length >= o.maxFiles) break;
  }
  return queueDownloads(urls.slice(0, o.maxFiles), { folder: o.folder || taskName, source: "task", refId: run.recipe_id }).added.length;
}

export function pauseDownloads(ids: string[] | "all") {
  let n = setDownloadStatus(ids, ["queued"], "paused");
  for (const [id, r] of state.running) {
    if (ids === "all" || ids.includes(id)) { r.reason = "pause"; r.ctrl.abort(); n++; }
  }
  return n;
}

/** Paused downloads go back in the queue; picked ones that failed are retried too. */
export function resumeDownloads(ids: string[] | "all") {
  const n = setDownloadStatus(ids, ids === "all" ? ["paused"] : ["paused", "failed", "cancelled"], "queued");
  queueMicrotask(pumpDownloads);
  return n;
}

export async function cancelDownloads(ids: string[]) {
  let n = setDownloadStatus(ids, ["queued", "paused", "failed"], "cancelled", "Cancelled by you.");
  for (const [id, r] of state.running) if (ids.includes(id)) { r.reason = "cancel"; r.ctrl.abort(); n++; }
  for (const id of ids) {
    const d = getDownload(id);
    if (d?.path && d.status === "cancelled") await fsp.rm(`${d.path}.part`, { force: true }).catch(() => undefined);
  }
  return n;
}

export const runningDownloads = () => state.running.size;

/** Starts queued downloads up to the concurrency setting. */
export function pumpDownloads() {
  if (state.pumping) return;
  state.pumping = true;
  try {
    if (!state.recovered) { state.recovered = true; const n = requeueInterruptedDownloads(); if (n) log.info("downloads.resumed_after_restart", { count: n }); }
    const limit = getSettings().data.downloadConcurrency;
    while (state.running.size < limit) {
      const d = claimNextDownload();
      if (!d) break;
      void execute(d);
    }
  } catch (e) {
    log.error("downloads.pump_failed", { error: e as Error });
  } finally {
    state.pumping = false;
  }
}

class Stop extends Error {}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
});

async function execute(first: Download) {
  const ctrl = new AbortController();
  const entry = { ctrl, reason: null as "pause" | "cancel" | null };
  state.running.set(first.id, entry);
  emit(first.id);
  try {
    // Network errors and 5xx answers are retried with a growing wait, resuming from the partial file.
    for (let attempt = 1; ; attempt++) {
      const d = getDownload(first.id);
      if (!d) return;
      try {
        await downloadOne(d, ctrl.signal);
        break;
      } catch (e) {
        if (entry.reason) throw e;
        if (e instanceof Stop || attempt >= MAX_ATTEMPTS) throw e;
        const wait = 3000 * 2 ** (attempt - 1);
        updateDownload(d.id, { error: `${(e as Error).message} Retrying in ${Math.round(wait / 1000)} s…`, attempts: d.attempts + 1 });
        emit(d.id);
        await sleep(wait, ctrl.signal);
      }
    }
  } catch (e) {
    const fresh = getDownload(first.id);
    if (entry.reason === "pause") updateDownload(first.id, { status: "paused", error: null });
    else if (entry.reason === "cancel") {
      updateDownload(first.id, { status: "cancelled", error: "Cancelled by you." });
      if (fresh?.path) await fsp.rm(`${fresh.path}.part`, { force: true }).catch(() => undefined);
    } else {
      const msg = (e as Error).message || "The download failed.";
      updateDownload(first.id, { status: "failed", error: msg });
      log.warn("downloads.failed", { id: first.id, url: first.url, error: msg });
    }
  } finally {
    state.running.delete(first.id);
    emit(first.id);
    queueMicrotask(pumpDownloads);
  }
}

async function downloadOne(d: Download, signal: AbortSignal) {
  const s = getSettings();
  const maxBytes = s.data.maxDownloadMb * 1024 * 1024;
  const dir = path.join(downloadsRoot(), d.folder);
  await fsp.mkdir(dir, { recursive: true });
  let finalPath = d.path;
  let offset = 0;
  if (finalPath) {
    try { offset = (await fsp.stat(`${finalPath}.part`)).size; } catch { offset = 0; }
  }
  const pre = await preflight(d.url, { signal }).catch((e: Error) => { throw e instanceof FetchError && ["robots", "paused", "private"].includes(e.code) ? new Stop(e.message) : e; });

  // Wait for this site's turn to start the request; the transfer itself does not hold up other requests.
  let current = d.url;
  const res = await withHostTurn(pre.host, pre.minDelayMs, async () => {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await pre.guard(current);
      const r = await undiciFetch(current, {
        redirect: "manual", signal, dispatcher: dispatcherFor(s.scraping.proxyUrl),
        headers: {
          "user-agent": pre.fastUa || DEFAULT_FAST_UA, accept: "*/*",
          ...(offset > 0 && d.resumable ? { range: `bytes=${offset}-` } : {}),
          ...(new URL(current).hostname === pre.host ? pre.headers : {}),
        },
      });
      if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
        current = new URL(r.headers.get("location")!, current).toString();
        await r.body?.cancel();
        continue;
      }
      return r;
    }
    throw new Stop("Too many redirects.");
  });

  if (res.status === 416 && offset > 0 && d.total_bytes && offset >= d.total_bytes) {
    await res.body?.cancel();
  } else {
    if (res.status === 404 || res.status === 410) { await res.body?.cancel(); throw new Stop(`The file is not there (HTTP ${res.status}).`); }
    if (res.status === 401 || res.status === 403) { await res.body?.cancel(); throw new Stop(`The site refused the download (HTTP ${res.status}). It may need a sign-in.`); }
    if (res.status >= 400 || !res.body) { await res.body?.cancel(); throw new Error(`The site answered HTTP ${res.status}.`); }
    const partial = res.status === 206;
    if (!partial) offset = 0;
    const length = Number(res.headers.get("content-length") ?? 0) || null;
    const rangeTotal = Number(/\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "")?.[1] ?? 0) || null;
    const total = rangeTotal ?? (length !== null ? length + offset : null);
    if (total && total > maxBytes) { await res.body.cancel(); throw new Stop(`The file is ${(total / 1048576).toFixed(1)} MB, over the ${s.data.maxDownloadMb} MB limit in Settings → Data.`); }
    if (!finalPath) {
      finalPath = await freePath(dir, nameFromHeaders(res, d.file_name));
      // Reserve the name so a second download with the same name picks another.
      await fsp.writeFile(finalPath, "");
    }
    updateDownload(d.id, {
      path: finalPath, file_name: path.basename(finalPath), total_bytes: total, bytes: offset,
      content_type: res.headers.get("content-type")?.split(";")[0]?.trim() ?? null,
      resumable: /bytes/i.test(res.headers.get("accept-ranges") ?? "") || partial,
    });
    emit(d.id);

    let bytes = offset;
    let lastSave = Date.now();
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > maxBytes) { cb(new Stop(`The file is over the ${s.data.maxDownloadMb} MB limit in Settings → Data.`)); return; }
        if (Date.now() - lastSave > 1000) { lastSave = Date.now(); updateDownload(d.id, { bytes }); emit(d.id); }
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as never), meter, fs.createWriteStream(`${finalPath}.part`, { flags: partial ? "a" : "w" }), { signal });
    updateDownload(d.id, { bytes });
  }

  // Done: move the .part into place and record a checksum.
  await fsp.rename(`${finalPath}.part`, finalPath!);
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(/* turbopackIgnore: true */ finalPath!), hash);
  const size = (await fsp.stat(/* turbopackIgnore: true */ finalPath!)).size;
  updateDownload(d.id, { status: "done", bytes: size, total_bytes: size, sha256: hash.digest("hex"), finished_at: new Date().toISOString(), error: null });
  audit("downloads.done", { id: d.id, bytes: size });
}
