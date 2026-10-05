import * as z from "zod";
import { objectId } from "../../shared/http";

export const paymentIntentBody = z.strictObject({
  appointmentId: objectId,
  /** From the booking response; required without a session. */
  paymentToken: z.string().max(64).optional(),
});
