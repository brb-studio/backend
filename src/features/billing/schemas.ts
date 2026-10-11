import * as z from "zod";
import { PAYMENT_STATUSES } from "../../db/scoped";
import { objectId } from "../../shared/http";
import { normalizeCode, REFERRAL_CODE } from "./rules";

export const referralCode = z
  .string()
  .max(20)
  .transform(normalizeCode)
  .pipe(z.string().regex(REFERRAL_CODE, "unknown code format"));

export const referralCheck = z.strictObject({ code: referralCode });

export const paymentInput = z.strictObject({
  referralCode: referralCode.optional(),
});

export const listQuery = z.strictObject({
  status: z.enum(PAYMENT_STATUSES).default("pending"),
});

export const confirmBody = z.strictObject({
  /** What reached the owner's account; must equal the amount owed. */
  receivedMinor: z.int().min(1),
  reference: z.string().trim().min(1).max(120).optional(),
});

export const rejectBody = z.strictObject({
  reason: z.string().trim().min(1).max(500).optional(),
});

export { objectId };
