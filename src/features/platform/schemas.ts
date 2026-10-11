import * as z from "zod";
import { APPOINTMENT_STATUSES } from "../../db/scoped";
import { objectId } from "../../shared/http";

export const platformLogin = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(8).max(128),
});

const MAX_DAYS = 366;
const day = z.iso.date();
const dayMs = (value: string) => Date.parse(`${value}T00:00:00Z`);

export const filters = z
  .object({
    from: day,
    to: day,
    tenantId: objectId.optional(),
    branchId: objectId.optional(),
    barberId: objectId.optional(),
    status: z.enum(APPOINTMENT_STATUSES).optional(),
  })
  .refine(
    (f) => f.from <= f.to && dayMs(f.to) - dayMs(f.from) < MAX_DAYS * 864e5,
    {
      path: ["to"],
      error: `to must not precede from, at most ${MAX_DAYS} days apart`,
    },
  );

export type Filters = z.output<typeof filters>;

export const paging = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const breakdownQuery = z.object({
  by: z.enum(["tenant", "branch", "barber"]),
});

export const optionsQuery = z.object({
  tenantId: objectId.optional(),
  branchId: objectId.optional(),
});

export const commissionUpdate = z.strictObject({
  commissionBps: z.int().min(0).max(10_000).nullable(),
});

export const payoutCreate = z.strictObject({
  barberId: objectId,
  appointmentIds: z.array(objectId).min(1).max(200),
  reference: z.string().trim().min(1).max(120).optional(),
  paidAt: z.iso.datetime().pipe(z.coerce.date()).optional(),
});
