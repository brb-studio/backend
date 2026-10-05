import * as z from "zod";
import { objectId } from "../../shared/http";

export const paymentIntentBody = z.strictObject({
  appointmentId: objectId,
});
