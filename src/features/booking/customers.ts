import { ObjectId } from "mongodb";
import type { CustomerDoc, TenantDb, UserDoc } from "../../db/scoped";
import { isDuplicate } from "../../shared/http";

export async function customerForGuest(
  t: TenantDb,
  guest: { name: string; phone: string; email?: string },
): Promise<CustomerDoc> {
  const now = new Date();
  const upsert = () =>
    t.customers.findOneAndUpdate(
      { phone: guest.phone },
      {
        $setOnInsert: {
          _id: new ObjectId(),
          name: guest.name,
          email: guest.email,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true, returnDocument: "after" },
    );
  const customer = await upsert().catch((err) => {
    if (isDuplicate(err)) return upsert();
    throw err;
  });
  if (!customer) throw new Error("upsert returned nothing");
  return customer;
}

export async function customerForUser(
  t: TenantDb,
  user: UserDoc,
): Promise<CustomerDoc> {
  const linked = await t.customers.findOne({ userId: user._id });
  if (linked) return linked;
  const now = new Date();
  if (user.phone) {
    const guest = await t.customers.findOneAndUpdate(
      { phone: user.phone, userId: { $exists: false } },
      { $set: { userId: user._id, updatedAt: now } },
      { returnDocument: "after" },
    );
    if (guest) return guest;
  }
  const customer: CustomerDoc = {
    _id: new ObjectId(),
    tenantId: user.tenantId,
    userId: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await t.customers.insertOne(customer);
    return customer;
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    const again = await t.customers.findOne({ userId: user._id });
    if (again) return again;
    const { phone: _, ...withoutPhone } = customer;
    await t.customers.insertOne(withoutPhone);
    return withoutPhone;
  }
}

export async function findCustomer(
  t: TenantDb,
  who: { userId?: ObjectId; phone?: string },
) {
  if (who.userId) return t.customers.findOne({ userId: who.userId });
  if (who.phone) return t.customers.findOne({ phone: who.phone });
  return null;
}
