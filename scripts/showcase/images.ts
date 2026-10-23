import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Binary, type ObjectId } from "mongodb";
import type { ImageDoc } from "../../src/db/collections";
import { imageId, TENANT_ID } from "./ids";

/**
 * Photos come only from the licensed samples already in the repo (frontend/public/images/sample,
 * Unsplash License, see CREDITS.md there). Nothing is downloaded: a missing file just leaves the field empty.
 */
export const SAMPLE_DIR = join(
  import.meta.dir,
  "../../../frontend/public/images/sample",
);

export const SAMPLE_FILES = [
  "cover.jpg",
  "haircut.jpg",
  "beard.jpg",
  "cut-and-beard.jpg",
  "shave.jpg",
  "branch-centro.jpg",
  "branch-norte.jpg",
] as const;

const MAX_BYTES = 1024 * 1024;

/** file name → `/api/images/<id>` (the frontend proxy path admin uploads use too). */
export type ImageRefs = Map<string, string>;

export const ref = (img: ImageRefs, ...files: string[]) =>
  files.flatMap((file) => {
    const url = img.get(file);
    return url ? [url] : [];
  });

export function loadImages(createdBy: ObjectId, now: Date, dir = SAMPLE_DIR) {
  const docs: ImageDoc[] = [];
  const refs: ImageRefs = new Map();
  for (const file of SAMPLE_FILES) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!isJpeg || bytes.length === 0 || bytes.length > MAX_BYTES) continue;
    const id = imageId(file);
    docs.push({
      _id: id,
      tenantId: TENANT_ID,
      contentType: "image/jpeg",
      data: new Binary(bytes),
      size: bytes.length,
      createdBy,
      createdAt: now,
    });
    refs.set(file, `/api/images/${id}`);
  }
  return { docs, refs };
}
