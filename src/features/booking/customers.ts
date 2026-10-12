import { ObjectId } from "mongodb";
import type { TenantDb, UserDoc } from "../../db/scoped";
import { isDuplicate } from "../../shared/http";

export async function customerForGuest(
  t: TenantDb,
  guest: { name: string; phone: string; email?: string },
): Promise<UserDoc> {
  const now = new Date();
  const upsert = () =>
    t.users.findOneAndUpdate(
      { guest: true, phone: guest.phone },
      {
        $setOnInsert: {
          _id: new ObjectId(),
          role: "customer",
          active: true,
          name: guest.name,
          ...(guest.email && { contactEmail: guest.email }),
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

export const findGuest = (t: TenantDb, phone: string | undefined) =>
  phone ? t.users.findOne({ guest: true, phone }) : null;
