import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { fetch as undiciFetch } from "undici";
import { env } from "../env";
import { dispatcherFor } from "../fetcher/http";
import { HttpError } from "../api";
import { audit } from "../repo/events";
import { deleteExtensionRow, getExtension, listExtensions, saveExtension, type Extension } from "../repo/browser";
import { getSettings } from "../repo/settings";

/**
 * Chrome extensions for Scaper's browser, kept unpacked in data/browser-extensions/<id>. They come from a .zip or
 * .crx you upload, or from a Chrome Web Store link (Scaper downloads the same package Chrome would). They load in
 * the normal profile only; incognito starts without them, like Chrome.
 */

const MAX_PACKAGE = 60 * 1024 * 1024;
const MAX_FILES = 6000;
const MAX_UNPACKED = 250 * 1024 * 1024;

export const extensionsRoot = () => path.join(env.dataDir, "browser-extensions");
export const extensionDir = (id: string) => path.join(extensionsRoot(), id);

/** The ids Chrome gives extensions: 32 letters a-p from a SHA-256 (of the manifest key, or else of the folder path). */
const toChromeId = (hex: string) => hex.slice(0, 32).split("").map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
export function chromeIdFor(manifest: Record<string, unknown>, dir: string) {
  if (typeof manifest.key === "string") {
    try { return toChromeId(createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex")); } catch { /* fall back to the path */ }
  }
  return toChromeId(createHash("sha256").update(path.resolve(dir)).digest("hex"));
}

/** Extension ids in Web Store links: …/detail/name/<32 letters a-p>. */
export function storeIdFrom(input: string) {
  return /(?:^|[/=])([a-p]{32})(?:[/?#&]|$)/.exec(input.trim())?.[1] ?? null;
}

/** A .crx is a header followed by a normal zip; return the zip part. */
export function crxToZip(buf: Uint8Array): Uint8Array {
  if (buf[0] === 0x50 && buf[1] === 0x4b) return buf; // already a zip
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, false) !== 0x43723234) throw new HttpError(400, "bad_package", "This is not a .zip or .crx extension package.");
  const version = dv.getUint32(4, true);
  if (version === 3) return buf.subarray(12 + dv.getUint32(8, true));
  if (version === 2) return buf.subarray(16 + dv.getUint32(8, true) + dv.getUint32(12, true));
  throw new HttpError(400, "bad_package", `Unknown .crx version ${version}.`);
}

/** Unzips safely: no paths outside the folder, a cap on files and size. Handles a zip with one top folder. */
export function unpack(zip: Uint8Array) {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(zip); } catch { throw new HttpError(400, "bad_package", "The package could not be unzipped."); }
  const names = Object.keys(files).filter((n) => !n.endsWith("/"));
  if (names.length > MAX_FILES) throw new HttpError(400, "bad_package", `The package has more than ${MAX_FILES} files.`);
  let total = 0;
  for (const n of names) {
    if (n.includes("\\") || n.startsWith("/") || n.split("/").some((p) => p === "..") || /^[a-z]:/i.test(n)) throw new HttpError(400, "bad_package", `The package has an unsafe path: ${n.slice(0, 80)}`);
    total += files[n]!.length;
  }
  if (total > MAX_UNPACKED) throw new HttpError(400, "bad_package", "The unpacked extension is over 250 MB.");
  // Some zips put everything in one folder; use the folder that holds manifest.json.
  const manifestPath = names.includes("manifest.json") ? "manifest.json" : names.filter((n) => n.endsWith("/manifest.json")).sort((a, b) => a.length - b.length)[0];
  if (!manifestPath) throw new HttpError(400, "bad_package", "There is no manifest.json in this package, so it is not a Chrome extension.");
  const prefix = manifestPath.slice(0, -"manifest.json".length);
  const out: Record<string, Uint8Array> = {};
  for (const n of names) if (n.startsWith(prefix)) out[n.slice(prefix.length)] = files[n]!;
  return out;
}

function readManifest(files: Record<string, Uint8Array>) {
  let m: Record<string, unknown>;
  try { m = JSON.parse(Buffer.from(files["manifest.json"]!).toString("utf8").replace(/^﻿/, "")) as Record<string, unknown>; }
  catch { throw new HttpError(400, "bad_package", "manifest.json is not valid JSON."); }
  if (m.manifest_version !== 2 && m.manifest_version !== 3) throw new HttpError(400, "bad_package", "manifest.json has no manifest_version 2 or 3.");
  // Names like __MSG_appName__ come from _locales.
  const locale = typeof m.default_locale === "string" ? m.default_locale : "en";
  let messages: Record<string, { message?: string }> = {};
  for (const l of [locale, "en", "en_US"]) {
    const f = files[`_locales/${l}/messages.json`];
    if (f) { try { messages = JSON.parse(Buffer.from(f).toString("utf8").replace(/^﻿/, "")) as typeof messages; break; } catch { /* ignore */ } }
  }
  const msg = (v: unknown) => {
    const s = typeof v === "string" ? v : "";
    const k = /^__MSG_(\w+)__$/.exec(s)?.[1];
    if (!k) return s;
    const hit = Object.entries(messages).find(([key]) => key.toLowerCase() === k.toLowerCase());
    return hit?.[1].message ?? s;
  };
  const action = (m.action ?? m.browser_action ?? m.page_action) as { default_popup?: string } | undefined;
  const opts = (m.options_ui as { page?: string } | undefined)?.page ?? (typeof m.options_page === "string" ? m.options_page : null);
  return {
    manifest: m, name: msg(m.name).slice(0, 120) || "Extension", version: String(m.version ?? "").slice(0, 40),
    description: msg(m.description).slice(0, 400), options: opts, popup: action?.default_popup ?? null,
  };
}

/** Installs (or updates) an extension from a package. Returns the saved row; the browser reloads it on its next start. */
export async function installPackage(buf: Uint8Array, source: Extension["source"], storeId: string | null = null) {
  if (buf.length > MAX_PACKAGE) throw new HttpError(413, "too_large", "Extension packages are limited to 60 MB.");
  const files = unpack(crxToZip(buf));
  const info = readManifest(files);
  // Unpacked extensions get their id from their folder, so write to a temporary folder named after the key-based id first.
  const tmp = path.join(extensionsRoot(), `.tmp-${Date.now()}`);
  for (const [name, data] of Object.entries(files)) {
    const p = path.join(tmp, name);
    if (!p.startsWith(tmp + path.sep)) throw new HttpError(400, "bad_package", "The package has an unsafe path.");
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, data);
  }
  const key = typeof info.manifest.key === "string" ? chromeIdFor(info.manifest, tmp) : null;
  const folderId = key ?? storeId ?? createHash("sha256").update(`${info.name}|${Date.now()}`).digest("hex").slice(0, 16);
  const dir = extensionDir(folderId);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rename(tmp, dir);
  const id = chromeIdFor(info.manifest, dir);
  const row = saveExtension({
    id: folderId, name: info.name, version: info.version, description: info.description, source, store_id: storeId ?? null,
    options_page: info.options ? `chrome-extension://${id}/${info.options.replace(/^\//, "")}` : null,
    popup_page: info.popup ? `chrome-extension://${id}/${info.popup.replace(/^\//, "")}` : null,
  });
  audit("browser.extension_installed", { id: folderId, name: info.name, version: info.version, source });
  return row;
}

/** Downloads a Web Store extension the way Chrome does (its update service), then installs it. */
export async function installFromStore(link: string) {
  const id = storeIdFrom(link);
  if (!id) throw new HttpError(400, "bad_link", "Paste a Chrome Web Store link like https://chromewebstore.google.com/detail/name/abcdefghijklmnopabcdefghijklmnop, or the 32-letter id.");
  const base = process.env.SCAPER_CRX_URL ?? "https://clients2.google.com/service/update2/crx";
  const url = `${base}?response=redirect&prodversion=141.0.0.0&acceptformat=crx2,crx3&x=${encodeURIComponent(`id=${id}&installsource=ondemand&uc`)}`;
  let res;
  try {
    res = await undiciFetch(url, { dispatcher: dispatcherFor(getSettings().scraping.proxyUrl), signal: AbortSignal.timeout(60_000), headers: { "user-agent": "Mozilla/5.0 Chrome/141.0.0.0" } });
  } catch (e) {
    throw new HttpError(502, "store_unreachable", `Could not reach the Chrome Web Store: ${((e as Error).cause as Error | undefined)?.message ?? (e as Error).message}. You can download the extension's .crx or .zip and upload it instead.`);
  }
  if (res.status === 204 || res.status === 404) throw new HttpError(404, "not_found", "The Chrome Web Store has no extension with that id.");
  if (!res.ok) throw new HttpError(502, "store_error", `The Chrome Web Store answered ${res.status}.`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return installPackage(buf, "store", id);
}

export async function removeExtension(id: string) {
  if (!getExtension(id)) return false;
  await fsp.rm(extensionDir(id), { recursive: true, force: true });
  deleteExtensionRow(id);
  audit("browser.extension_removed", { id });
  return true;
}

/** Folders of the extensions to load: enabled and still on disk. */
export function enabledExtensionDirs() {
  return listExtensions().filter((e) => e.enabled).map((e) => extensionDir(e.id)).filter((d) => fs.existsSync(path.join(d, "manifest.json")));
}
