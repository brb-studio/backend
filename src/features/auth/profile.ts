import { forTenant } from "../../db/scoped";
import { AppError, type Auth } from "../../shared/http";
import { providerError, stripe } from "../payments/stripe/client";
import { customer as stripeCustomer } from "../payments/stripe/types";
import { getUser } from "./service";

export async function updateProfile(
  auth: Auth,
  input: { name: string; phone?: string },
  now = new Date(),
) {
  const user = await getUser(auth);
  if (user.stripeCustomerId) {
    await stripe
      .post(stripeCustomer, `/v1/customers/${user.stripeCustomerId}`, {
        name: input.name,
        phone: input.phone ?? "",
      })
      .catch((err: unknown) => {
        throw providerError(err, "stripe_customer_update_failed");
      });
  }
  const updated = await forTenant(auth.tenantId).users.findOneAndUpdate(
    { _id: user._id },
    {
      $set: {
        name: input.name,
        updatedAt: now,
        ...(input.phone && { phone: input.phone }),
      },
      ...(!input.phone && { $unset: { phone: "" } }),
    },
    { returnDocument: "after" },
  );
  if (!updated) throw new AppError(401, "UNAUTHENTICATED", "Sign in required");
  return updated;
}
