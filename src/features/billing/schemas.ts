import * as z from "zod";
import { normalizeCode, REFERRAL_CODE } from "./rules";

export const referralCode = z
  .string()
  .max(20)
  .transform(normalizeCode)
  .pipe(z.string().regex(REFERRAL_CODE, "unknown code format"));

/** Where Stripe sends the owner back; checked against the tenant's own host in the service. */
const returnUrl = z.url({ protocol: /^https?$/ }).max(500);

export const referralCheck = z.strictObject({ code: referralCode });

export const checkoutInput = z.strictObject({
  referralCode: referralCode.optional(),
  returnUrl,
});

export const portalInput = z.strictObject({ returnUrl });
