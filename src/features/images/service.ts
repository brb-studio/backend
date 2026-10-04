import { randomBytes } from "node:crypto";
import { Binary } from "mongodb";
import { hit } from "../../db/rate-limit";
import { forTenant, platform } from "../../db/scoped";
import { AppError, type Auth } from "../../shared/http";

export const MAX_IMAGE_BYTES = 1024 * 1024;
// ponytail: flat cap per tenant, no cleanup of replaced photos; a per-plan quota + GC when storage matters.
const MAX_IMAGES_PER_TENANT = 500;
const HOUR_MS = 60 * 60 * 1000;

export type ImageType = "image/jpeg" | "image/png" | "image/webp";

/**
 * The real type, from the file's first bytes; the client's Content-Type is never trusted. Only JPEG,
 * PNG and WebP: SVG is refused because it can carry scripts.
 */
export function sniff(bytes: Uint8Array): ImageType | undefined {
  const at = (offset: number, signature: number[]) =>
    signature.every((byte, i) => bytes[offset + i] === byte);
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp";
  }
  return undefined;
}

/** Stores a photo for this tenant. Ids are 128-bit random, so nobody can walk through other shops' files. */
export async function uploadImage(auth: Auth, bytes: Uint8Array) {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new AppError(413, "TOO_LARGE", "Images must be 1 MB or less");
  }
  const contentType = sniff(bytes);
  if (!contentType) {
    throw new AppError(415, "UNSUPPORTED_IMAGE", "Use a JPEG, PNG or WebP");
  }
  if (!(await hit(`image:${auth.userId}`, 60, HOUR_MS))) {
    throw new AppError(429, "RATE_LIMITED", "Too many uploads, try later");
  }
  const t = forTenant(auth.tenantId);
  if ((await t.images.countDocuments()) >= MAX_IMAGES_PER_TENANT) {
    throw new AppError(409, "IMAGE_LIMIT", "This shop has too many images");
  }
  const id = randomBytes(16).toString("base64url");
  await t.images.insertOne({
    _id: id,
    contentType,
    data: new Binary(bytes),
    size: bytes.length,
    createdBy: auth.userId,
    createdAt: new Date(),
  });
  return { id };
}

/** Photos are public (they're on the shop's pages), looked up by their unguessable id alone. */
export const findImage = (id: string) =>
  platform.images.findOne(
    { _id: id },
    { projection: { contentType: 1, data: 1 } },
  );
