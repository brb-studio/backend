import * as z from "zod";
import { objectId } from "../../shared/http";
import { localized } from "../tenancy/schemas";

export const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_-]{3,32}$/, "3–32 letters, digits, - or _");

const instant = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));
const ids = z.array(objectId).max(100);

const fields = {
  name: localized(80),
  code,
  type: z.enum(["percent", "fixed"]),
  value: z.int().min(1).max(10_000_000),
  startsAt: instant,
  endsAt: instant,
  branchIds: ids,
  serviceIds: ids,
  packageIds: ids,
  minSubtotalMinor: z.int().min(0).max(100_000_000),
  firstVisitOnly: z.boolean(),
  maxRedemptions: z.int().min(1).max(10_000_000),
  maxPerCustomer: z.int().min(1).max(1000),
};

export const promotionCreate = z
  .strictObject({
    ...fields,
    code: fields.code.optional(),
    startsAt: fields.startsAt.optional(),
    endsAt: fields.endsAt.optional(),
    branchIds: fields.branchIds.default([]),
    serviceIds: fields.serviceIds.default([]),
    packageIds: fields.packageIds.default([]),
    minSubtotalMinor: fields.minSubtotalMinor.optional(),
    firstVisitOnly: fields.firstVisitOnly.default(false),
    maxRedemptions: fields.maxRedemptions.optional(),
    maxPerCustomer: fields.maxPerCustomer.optional(),
  })
  .refine((p) => p.type !== "percent" || p.value <= 100, {
    path: ["value"],
    error: "a percentage is 1–100",
  })
  .refine((p) => !p.startsAt || !p.endsAt || p.startsAt < p.endsAt, {
    path: ["endsAt"],
    error: "must be after startsAt",
  });

export const promotionUpdate = z
  .strictObject({
    ...z.object(fields).partial().shape,
    active: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    error: "nothing to update",
  });
