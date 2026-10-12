import * as z from "zod";
import { LOCALES, PAYMENT_KINDS, PAYMENT_STATUSES } from "../../db/scoped";
import { objectId } from "../../shared/http";
import { isValidClabe } from "./clabe";

export const onboardingBody = z.strictObject({
  locale: z.enum(LOCALES).optional(),
});

export const depositBody = z.strictObject({
  enabled: z.boolean(),
  /** 100 = 1% … 10000 = 100% of the visit. */
  percentBps: z.int().min(100).max(10_000),
});

export const checkoutQuery = z.strictObject({
  paymentToken: z.string().max(64).optional(),
  /** `1` to get the card form's client secret again (reopening the payment modal); polling omits it. */
  secret: z.literal("1").optional(),
});

export const switchBody = z.strictObject({
  kind: z.enum(PAYMENT_KINDS),
  method: z.enum(["card", "bank_transfer"]),
  paymentToken: z.string().max(64).optional(),
});

export const refundBody = z.strictObject({
  amountMinor: z.int().min(1).max(100_000_000).optional(),
});

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
