import { forTenant, type TenantDoc } from "../../db/scoped";
import { collect } from "../../shared/cursor";
import { AppError } from "../../shared/http";
import { releaseOrder } from "./orders";

const MAX_PER_RUN = 200;

export async function expireOrders(
  tenant: Pick<TenantDoc, "_id" | "products">,
  now = new Date(),
) {
  if (!tenant.products?.enabled) return;
  const t = forTenant(tenant._id);
  const stale = await collect(
    t.productOrders
      .find({ status: "reserved", expiresAt: { $lt: now } })
      .limit(MAX_PER_RUN),
  );
  for (const order of stale) {
    await releaseOrder(t, order, "expired").catch((err: unknown) => {
      if (!(err instanceof AppError && err.code === "NOT_RESERVED")) throw err;
    });
  }
}
