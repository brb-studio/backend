import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";

/** The showcase barbershop: a fixed slug and a fixed seed, so every run builds the same shop. */
export const SLUG = "montecobre";
export const SEED = 20261023;

const digest = (key: string) =>
  createHash("sha256").update(`${SLUG}:${key}`).digest();

/** Deterministic ObjectId: the same key always maps to the same id, so reruns replace instead of adding. */
export const oid = (key: string) => new ObjectId(digest(key).subarray(0, 12));

/** Deterministic image id with the shape uploads use (22 base64url characters). */
export const imageId = (file: string) =>
  digest(`img:${file}`).toString("base64url").slice(0, 22);

export const TENANT_ID = oid("tenant");

export type Rng = () => number;

/** mulberry32: tiny, fast and good enough for demo data. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generator for one topic (a barber's day, a customer): the same key gives the same numbers whatever "now" is. */
export const rngFor = (key: string) =>
  mulberry32((SEED ^ digest(`rng:${key}`).readUInt32BE(0)) >>> 0);

export const between = (rng: Rng, min: number, max: number) =>
  min + Math.floor(rng() * (max - min + 1));

export const chance = (rng: Rng, p: number) => rng() < p;

export function pick<T>(rng: Rng, list: readonly T[]): T {
  const value = list[Math.floor(rng() * list.length)];
  if (value === undefined) throw new Error("pick from an empty list");
  return value;
}

export function weighted<T>(rng: Rng, entries: readonly [T, number][]): T {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [value, w] of entries) {
    roll -= w;
    if (roll < 0) return value;
  }
  const last = entries.at(-1);
  if (!last) throw new Error("weighted pick from an empty list");
  return last[0];
}

export const MINUTE = 60_000;
export const DAY = 864e5;

/** "HH:MM" ⇄ minutes since local midnight. */
export const toMinutes = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
export const toHHMM = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** Local calendar arithmetic on "YYYY-MM-DD" (Temporal), and its weekday with Sunday = 0 like `Hours`. */
export const plainDay = (date: string, days: number) =>
  Temporal.PlainDate.from(date).add({ days }).toString();
export const weekdayOf = (date: string) =>
  Temporal.PlainDate.from(date).dayOfWeek % 7;
