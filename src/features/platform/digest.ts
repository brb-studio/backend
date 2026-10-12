import type { WithId } from "mongodb";
import { platform, type TenantDoc } from "../../db/scoped";
import { sendDigest } from "../notifications/digest";
import { isSubscriptionActive } from "../tenancy/subscription";

type Row = WithId<Pick<TenantDoc, "name" | "defaultLocale" | "subscription">>;

/** Morning summary for every barbershop with an active subscription; one failing shop never stops the rest. */
export async function runDigests(now = new Date()) {
  const cursor = platform.tenants
    .find({})
    .project<Row>({ name: 1, defaultLocale: 1, subscription: 1 });
  for await (const tenant of cursor) {
    if (!isSubscriptionActive(tenant.subscription, now)) continue;
    await sendDigest(tenant, now).catch((err: unknown) =>
      console.error(
        JSON.stringify({
          level: "error",
          event: "digest_failed",
          tenant: tenant._id.toHexString(),
          message: String(err),
        }),
      ),
    );
  }
}
