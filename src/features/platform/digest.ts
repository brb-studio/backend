import type { WithId } from "mongodb";
import { platform, type TenantDoc } from "../../db/scoped";
import { sendDigest } from "../notifications/digest";
import { sendReminders } from "../notifications/reminders";
import { expireOrders } from "../products/expire";
import { isSubscriptionActive } from "../tenancy/subscription";
import { notifyWaitlist } from "../waitlist/notify";

type Row = WithId<
  Pick<
    TenantDoc,
    | "name"
    | "slug"
    | "customDomain"
    | "defaultLocale"
    | "subscription"
    | "reminders"
  >
>;

const failed = (event: string, tenant: Row) => (err: unknown) =>
  console.error(
    JSON.stringify({
      level: "error",
      event,
      tenant: tenant._id.toHexString(),
      message: String(err),
    }),
  );

export async function runScheduled(now = new Date()) {
  const cursor = platform.tenants.find({}).project<Row>({
    name: 1,
    slug: 1,
    customDomain: 1,
    defaultLocale: 1,
    subscription: 1,
    reminders: 1,
    products: 1,
  });
  for await (const tenant of cursor) {
    if (!isSubscriptionActive(tenant.subscription, now)) continue;
    await sendDigest(tenant, now).catch(failed("digest_failed", tenant));
    await sendReminders(tenant, now).catch(failed("reminders_failed", tenant));
    await notifyWaitlist(tenant, now).catch(failed("waitlist_failed", tenant));
    await expireOrders(tenant, now).catch(failed("products_failed", tenant));
  }
}
