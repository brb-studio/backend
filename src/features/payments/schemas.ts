import * as z from "zod";
import { PAYMENT_STATUSES } from "../../db/scoped";
import { objectId } from "../../shared/http";
import { isValidClabe } from "./clabe";

export const transferBody = z.strictObject({
  appointmentId: objectId,
  paymentToken: z.string().max(64).optional(),
});

const clabe = z
  .string()
  .regex(/^\d{18}$/, "must be 18 digits")
  .refine(isValidClabe, { error: "invalid CLABE check digit" });

export const bankSettings = z
  .strictObject({
    bankTransferEnabled: z.boolean(),
    bankAccountKey: clabe.optional(),
    bankAccountHolder: z.string().trim().min(1).max(120).optional(),
  })
  .refine(
    (input) =>
      !input.bankTransferEnabled ||
      (input.bankAccountKey && input.bankAccountHolder),
    { path: ["bankAccountKey"], error: "needed to enable transfers" },
  );

export const listQuery = z.strictObject({
  status: z.enum(PAYMENT_STATUSES).default("pending"),
});

export const confirmBody = z.strictObject({

  receivedMinor: z.int().min(1),
  reference: z.string().trim().min(1).max(120).optional(),
});

export const rejectBody = z.strictObject({
  reason: z.string().trim().min(1).max(500).optional(),
});
