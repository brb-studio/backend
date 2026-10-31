import { hit } from "../../db/rate-limit";
import { forTenant, type Locale, platform } from "../../db/scoped";
import { AppError, type Auth } from "../../shared/http";
import { providerError, stripe } from "../payments/stripe/client";
import { customer as stripeCustomer } from "../payments/stripe/types";
import { getUser } from "./service";

const ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

const ERASED_NAME: Record<Locale, string> = {
  es: "Cliente eliminado",
  en: "Deleted customer",
};

export async function deleteAccount(
  auth: Auth,
  password: string,
  locale: Locale,
  now = new Date(),
) {
  if (!(await hit(`erase:${auth.userId}`, ATTEMPTS, WINDOW_MS))) {
    throw new AppError(
      429,
      "RATE_LIMITED",
      "Too many attempts, try again later",
    );
  }
  const user = await getUser(auth);
  if (
    !user.passwordHash ||
    !(await Bun.password.verify(password, user.passwordHash))
  ) {
    throw new AppError(403, "WRONG_PASSWORD", "Password is wrong");
  }
  const t = forTenant(auth.tenantId);
  const [visit, order] = await Promise.all([
    t.appointments.findOne(
      {
        customerId: user._id,
        status: { $in: ["confirmed", "pending_payment"] },
        startAt: { $gt: now },
      },
      { projection: { _id: 1 } },
    ),
    t.productOrders.findOne(
      { customerId: user._id, status: "reserved" },
      { projection: { _id: 1 } },
    ),
  ]);
  if (visit || order) {
    throw new AppError(
      409,
      "OPEN_BOOKINGS",
      "Cancel your upcoming visits and reservations first",
    );
  }
  if (user.stripeCustomerId) {
    await stripe
      .post(stripeCustomer, `/v1/customers/${user.stripeCustomerId}`, {
        name: "",
        email: "",
        phone: "",
      })
      .catch((err: unknown) => {
        throw providerError(err, "stripe_customer_erase_failed");
      });
  }
  await t.users.updateOne(
    { _id: user._id },
    {
      $set: {
        name: ERASED_NAME[locale],
        active: false,
        deletedAt: now,
        updatedAt: now,
      },
      $unset: {
        email: "",
        passwordHash: "",
        phone: "",
        contactEmail: "",
        emailVerifiedAt: "",
        stripeCustomerId: "",
      },
    },
  );
  await Promise.all([
    platform.sessions.deleteMany({ userId: user._id }),
    t.authTokens.deleteMany({ userId: user._id }),
    t.pushSubscriptions.deleteMany({ userId: user._id }),
    t.nativePushDevices.deleteMany({ userId: user._id }),
    t.notifications.deleteMany({ userId: user._id }),
    t.waitlist.deleteMany({ customerId: user._id }),
  ]);
}
