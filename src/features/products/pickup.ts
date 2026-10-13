import type { Filter, ObjectId } from "mongodb";
import {
  forTenant,
  type ProductOrderDoc,
  type TenantDoc,
} from "../../db/scoped";
import { collect } from "../../shared/cursor";
import { AppError, type Auth } from "../../shared/http";
import { visibleBranchIds } from "../auth/policy";
import { type OrderContext, orderView, releaseOrder } from "./orders";
import { orderIdOf } from "./token";

const notFound = () => new AppError(404, "NOT_FOUND", "Not found");
const MAX_PENDING = 100;

function visibleTo(auth: Auth): Filter<ProductOrderDoc> {
  const ids = visibleBranchIds(auth);
  return ids ? { branchId: { $in: ids } } : {};
}

async function withContext(tenant: TenantDoc, orders: ProductOrderDoc[]) {
  const t = forTenant(tenant._id);
  const branches = new Map<string, NonNullable<OrderContext["branch"]>>();
  const customers = new Map<string, NonNullable<OrderContext["customer"]>>();
  for (const o of orders) {
    const branchKey = o.branchId.toHexString();
    if (!branches.has(branchKey)) {
      const branch = await t.branches.findOne(
        { _id: o.branchId },
        { projection: { slug: 1, name: 1 } },
      );
      if (branch)
        branches.set(branchKey, { slug: branch.slug, name: branch.name });
    }
    const customerKey = o.customerId.toHexString();
    if (!customers.has(customerKey)) {
      const user = await t.users.findOne(
        { _id: o.customerId },
        { projection: { name: 1, phone: 1 } },
      );
      if (user) {
        customers.set(customerKey, {
          name: user.name,
          ...(user.phone && { phone: user.phone }),
        });
      }
    }
  }
  return orders.map((o) =>
    orderView(o, {
      branch: branches.get(o.branchId.toHexString()),
      customer: customers.get(o.customerId.toHexString()),
    }),
  );
}

export async function pendingOrders(tenant: TenantDoc, auth: Auth) {
  const orders = await collect(
    forTenant(tenant._id)
      .productOrders.find({ status: "reserved", ...visibleTo(auth) })
      .sort({ createdAt: 1 })
      .limit(MAX_PENDING),
  );
  return withContext(tenant, orders);
}

async function findOrder(tenant: TenantDoc, auth: Auth, id: ObjectId) {
  const order = await forTenant(tenant._id).productOrders.findOne({
    $and: [{ _id: id }, visibleTo(auth)],
  });
  if (!order) throw notFound();
  return order;
}

export async function scanOrder(tenant: TenantDoc, auth: Auth, code: string) {
  const id = orderIdOf(code);
  if (!id) throw notFound();
  const [view] = await withContext(tenant, [await findOrder(tenant, auth, id)]);
  return view;
}

export async function deliverOrder(
  tenant: TenantDoc,
  auth: Auth,
  id: ObjectId,
  method: NonNullable<ProductOrderDoc["payment"]>["method"],
) {
  const t = forTenant(tenant._id);
  const now = new Date();
  const done = await t.productOrders.findOneAndUpdate(
    { $and: [{ _id: id, status: "reserved" }, visibleTo(auth)] },
    {
      $set: {
        status: "delivered",
        payment: { method, receivedBy: auth.userId, at: now },
        closedAt: now,
        closedBy: auth.userId,
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  );
  if (!done) {
    await findOrder(tenant, auth, id);
    throw new AppError(
      409,
      "NOT_RESERVED",
      "This reservation is no longer open",
    );
  }
  const [view] = await withContext(tenant, [done]);
  return view;
}

export async function cancelOrderAsStaff(
  tenant: TenantDoc,
  auth: Auth,
  id: ObjectId,
) {
  const order = await findOrder(tenant, auth, id);
  await releaseOrder(forTenant(tenant._id), order, "cancelled", auth.userId);
}
