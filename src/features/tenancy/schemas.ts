import * as z from "zod";
import type { BookingRules, Hours } from "../../db/scoped";

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const slug = z.string().max(64).regex(SLUG);

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isTimeZone(timeZone: string) {
  if (!/^[A-Za-z][\w+/-]*$/.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function hoursOverlap(hours: Hours[]) {
  const sorted = hours.toSorted(
    (a, b) => a.weekday - b.weekday || a.open.localeCompare(b.open),
  );
  return sorted.some((h, i) => {
    const prev = sorted[i - 1];
    return prev?.weekday === h.weekday && h.open < prev.close;
  });
}

const timeZone = z
  .string()
  .max(64)
  .refine(isTimeZone, { error: "unknown IANA time zone" });

export const hours = z
  .array(
    z
      .strictObject({
        weekday: z.int().min(0).max(6),
        open: z.string().regex(HHMM),
        close: z.string().regex(HHMM),
      })
      .refine((h) => h.open < h.close, {
        path: ["close"],
        error: "must be after open",
      }),
  )
  .max(21)
  .refine((h) => !hoursOverlap(h), { error: "intervals overlap" });

const bookingRules = z.strictObject({
  slotIntervalMin: z.int().min(5).max(240),
  bufferMin: z.int().min(0).max(120),
  minNoticeMin: z.int().min(0).max(10_080),
  windowDays: z.int().min(1).max(365),
  cancelNoticeMin: z.int().min(0).max(10_080),
});

export const DEFAULT_BOOKING: BookingRules = {
  slotIntervalMin: 15,
  bufferMin: 0,
  minNoticeMin: 60,
  windowDays: 14,
  cancelNoticeMin: 120,
};

const https = z.url({ protocol: /^https$/ }).max(500);
export const image = z
  .string()
  .max(500)
  .regex(/^(\/|https:\/\/)/, "must be a /path or https URL");

/** A gallery, cover first. */
export const images = z.array(image).max(12);

export const localized = (max: number) =>
  z
    .strictObject({
      es: z.string().trim().min(1).max(max).optional(),
      en: z.string().trim().min(1).max(max).optional(),
    })
    .refine((text) => text.es || text.en, { error: "needs es or en" });

const branchFields = {
  slug,
  name: z.string().trim().min(1).max(80),
  address: z.array(z.string().trim().min(1).max(120)).min(1).max(4),
  phone: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, "must be E.164, e.g. +526641234567"),
  mapsUrl: https,
  images,
  timeZone,
  hours,
};

export const branchCreate = z.strictObject({
  ...branchFields,
  phone: branchFields.phone.optional(),
  mapsUrl: branchFields.mapsUrl.optional(),
  images: branchFields.images.optional(),
  booking: bookingRules
    .partial()
    .default({})
    .transform((rules) => ({ ...DEFAULT_BOOKING, ...rules })),
});

export const branchUpdate = z
  .strictObject({
    ...z.object(branchFields).partial().shape,
    booking: bookingRules.partial().optional(),
    active: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    error: "nothing to update",
  });

const THEME_TOKENS = [
  "canvas",
  "surface",
  "card",
  "fg",
  "fg-muted",
  "line",
  "line-strong",
  "glass",
  "sheet",
  "accent",
  "accent-fg",
  "accent-text",
] as const;
const color = z
  .string()
  .max(64)
  .regex(
    /^(#[0-9a-f]{3,8}|[a-z]+|(rgb|rgba|hsl|hsla|oklch|oklab|color-mix)\([^;{}<>"']*\))$/i,
  );

export const tenantUpdate = z
  .strictObject({
    name: z.string().trim().min(1).max(80).optional(),
    brand: z
      .strictObject({
        instagramUrl: https.optional(),
        authImage: image.optional(),
        coverImage: image.optional(),
      })
      .optional(),
    theme: z
      .partialRecord(
        z.enum(THEME_TOKENS),
        z.union([color, z.strictObject({ light: color, dark: color })]),
      )
      .optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    error: "nothing to update",
  });
