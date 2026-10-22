import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { env } from "../env";

/** Screenshots and diff images live under data/media; the database stores only relative paths. */
export const mediaRoot = () => path.join(env.dataDir, "media");

export async function saveMedia(rel: string, data: Buffer) {
  const file = path.join(mediaRoot(), rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
  return rel;
}

export async function readMedia(rel: string): Promise<Buffer | null> {
  const file = resolveMedia(rel);
  if (!file) return null;
  return fs.readFile(file).catch(() => null);
}

/** Resolves a stored relative path, refusing anything that escapes the media folder. */
export function resolveMedia(rel: string): string | null {
  const root = mediaRoot();
  const file = path.resolve(root, rel);
  return file.startsWith(root + path.sep) ? file : null;
}

export async function deleteMedia(rels: (string | null | undefined)[]) {
  await Promise.all(rels.filter(Boolean).map((r) => {
    const f = resolveMedia(r!);
    return f ? fs.rm(f, { force: true }) : undefined;
  }));
}

function onCanvas(img: PNG, width: number, height: number) {
  if (img.width === width && img.height === height) return img.data;
  // Padding is a colour pages rarely use, so area that exists in only one screenshot counts as changed.
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = 255; out[i + 1] = 0; out[i + 2] = 255; out[i + 3] = 255; }
  for (let y = 0; y < img.height; y++) img.data.copy(out, y * width * 4, y * img.width * 4, y * img.width * 4 + img.width * 4);
  return out;
}

/**
 * Pixel comparison of two PNG screenshots. Different sizes are compared on a
 * shared white canvas, so a page that grew counts as changed. Returns the
 * share of changed pixels and a diff image with changes painted red.
 */
export function compareImages(before: Buffer, after: Buffer, threshold = 0.1): { percent: number; diff: Buffer; width: number; height: number } {
  const a = PNG.sync.read(before);
  const b = PNG.sync.read(after);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const out = new PNG({ width, height });
  const changed = pixelmatch(onCanvas(a, width, height), onCanvas(b, width, height), out.data, width, height, {
    threshold, includeAA: false, alpha: 0.25, diffColor: [220, 38, 38], diffColorAlt: [22, 163, 74],
  });
  return { percent: Math.round((changed / (width * height)) * 10_000) / 100, diff: PNG.sync.write(out), width, height };
}
