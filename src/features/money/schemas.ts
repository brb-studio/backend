import * as z from "zod";
import {
  LEDGER_DIRECTIONS,
  LEDGER_METHODS,
  LEDGER_TYPES,
} from "../../db/scoped";
import { objectId } from "../../shared/http";

const MAX_DAYS = 366;
const day = z.iso.date();
const dayMs = (value: string) => Date.parse(`${value}T00:00:00Z`);
const inRange = (f: { from: string; to: string }) =>
  f.from <= f.to && dayMs(f.to) - dayMs(f.from) < MAX_DAYS * 864e5;
const rangeError = {
  path: ["to"],
  error: `to must not precede from, at most ${MAX_DAYS} days apart`,
};

export const summaryQuery = z
  .strictObject({
    from: day,
    to: day,
    groupBy: z.enum(["day", "week", "month"]).default("day"),
    branchId: objectId.optional(),
  })
  .refine(inRange, rangeError);

export const movementsQuery = z
  .strictObject({
    from: day,
    to: day,
    branchId: objectId.optional(),
    direction: z.enum(LEDGER_DIRECTIONS).optional(),
    type: z.enum(LEDGER_TYPES).optional(),
    method: z.enum(LEDGER_METHODS).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .refine(inRange, rangeError);

const amountMinor = z.int().min(1).max(100_000_000);
const concept = z.string().trim().min(1).max(120);
const note = z.string().trim().min(1).max(500);
const reference = z.string().trim().min(1).max(120);
const fields = {
  amountMinor,
  method: z.enum(LEDGER_METHODS),
  branchId: objectId,
  concept,
  reference: reference.optional(),
};

export const entryBody = z.union([
  z.strictObject({
    type: z.literal("expense"),
    ...fields,
    note: note.optional(),
  }),
  z.strictObject({
    type: z.literal("adjustment"),
    direction: z.enum(LEDGER_DIRECTIONS),
    ...fields,
    note,
  }),
  z.strictObject({
    type: z.literal("adjustment"),
    reverses: objectId,
    note,
  }),
]);
