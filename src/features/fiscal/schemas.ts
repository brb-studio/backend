import * as z from "zod";
import { RFC } from "../tenancy/schemas";

const UUID =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/** The data the customer gives for the CFDI: who receives it, under which tax regime and use. */
export const invoiceReceiver = z.strictObject({
  rfc: z.string().trim().toUpperCase().regex(RFC),
  legalName: z.string().trim().min(1).max(200),
  taxRegime: z.string().regex(/^\d{3}$/),
  postalCode: z.string().regex(/^\d{5}$/),
  cfdiUse: z.string().regex(/^[A-Z]\d{2}$/),
});

/** The shop records what happened in its own system: issued (with the stamp's UUID) or cancelled. */
export const invoiceUpdate = z
  .strictObject({
    status: z.enum(["issued", "cancelled"]),
    cfdiUuid: z.string().regex(UUID).optional(),
  })
  .refine(
    (input) => input.status !== "issued" || input.cfdiUuid !== undefined,
    {
      error: "cfdiUuid is required to mark an invoice as issued",
    },
  );
