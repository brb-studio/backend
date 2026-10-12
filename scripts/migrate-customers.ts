import type { ObjectId } from "mongodb";
import { client, db } from "../src/db/client";
import { appointments, specs, users } from "../src/db/collections";
import { ensureCollections } from "../src/db/setup";
import { isDuplicate } from "../src/shared/http";

/** The `customers` documents this migration reads (the collection is no longer part of the schema). */
type LegacyCustomer = {
  _id: ObjectId;
  tenantId: ObjectId;
  userId?: ObjectId;
  name: string;
  phone?: string;
  email?: string;
  stripeCustomerId?: string;
};

export type MigrationReport = {
  /** Customers tied to an account: their appointments now point at the account. */
  linked: number;
  /** Customers without an account: copied to `users` as guest records, same `_id`. */
  guests: number;
  /** Guests whose phone already had a guest record: appointments moved onto that record. */
  mergedByPhone: number;
  appointmentsRemapped: number;
  /** Appointments whose `customerId` matches no user afterwards (apply only); should be 0. */
  unresolved: number;
};

/**
 * Folds the per-barbershop `customers` collection into `users`. Idempotent and resumable, and it
 * never deletes anything: `customers` stays untouched as the backup. Accounts are never merged
 * with each other or with guests by phone/email, since neither is verified; the only link used is
 * the `userId` the old record already carried.
 */
export async function migrateCustomers(
  apply: boolean,
): Promise<MigrationReport> {
  const report: MigrationReport = {
    linked: 0,
    guests: 0,
    mergedByPhone: 0,
    appointmentsRemapped: 0,
    unresolved: 0,
  };
  const legacy = db.collection<LegacyCustomer>("customers");
  for await (const c of legacy.find()) {
    const account = c.userId
      ? await users.findOne({ _id: c.userId, tenantId: c.tenantId })
      : null;
    let target = c._id;
    if (account) {
      report.linked++;
      target = account._id;
      if (apply) {
        await users.updateOne(
          { _id: account._id },
          {
            $set: {
              legacyCustomerId: c._id,
              ...(c.stripeCustomerId &&
                !account.stripeCustomerId && {
                  stripeCustomerId: c.stripeCustomerId,
                }),
            },
          },
        );
      }
    } else if (apply) {
      target = await guestFor(c, report);
    } else {
      report.guests++;
    }
    if (apply && !target.equals(c._id)) {
      const moved = await appointments.updateMany(
        { tenantId: c.tenantId, customerId: c._id },
        { $set: { customerId: target } },
      );
      report.appointmentsRemapped += moved.modifiedCount;
    }
  }
  if (apply) report.unresolved = await countUnresolved();
  return report;
}

async function guestFor(c: LegacyCustomer, report: MigrationReport) {
  const now = new Date();
  try {
    await users.updateOne(
      { _id: c._id, tenantId: c.tenantId },
      {
        $setOnInsert: {
          role: "customer",
          guest: true,
          active: true,
          name: c.name,
          ...(c.phone && { phone: c.phone }),
          ...(c.email && { contactEmail: c.email }),
          ...(c.stripeCustomerId && { stripeCustomerId: c.stripeCustomerId }),
          legacyCustomerId: c._id,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    report.guests++;
    return c._id;
  } catch (err) {
    if (!isDuplicate(err) || !c.phone) throw err;
  }
  // A guest record with this phone already exists (booked after the new code went live).
  const same = await users.findOne({
    tenantId: c.tenantId,
    guest: true,
    phone: c.phone,
  });
  if (!same) throw new Error(`duplicate guest for customer ${c._id}`);
  report.mergedByPhone++;
  return same._id;
}

async function countUnresolved() {
  const known = new Set<string>();
  let unresolved = 0;
  const cursor = appointments
    .find({}, { projection: { customerId: 1, tenantId: 1 } })
    .batchSize(500);
  for await (const a of cursor) {
    const key = `${a.tenantId}:${a.customerId}`;
    if (known.has(key)) continue;
    const exists = await users.countDocuments(
      { _id: a.customerId, tenantId: a.tenantId },
      { limit: 1 },
    );
    if (exists) known.add(key);
    else unresolved++;
  }
  return unresolved;
}

if (import.meta.main) {
  const apply = Bun.argv.includes("--apply");
  // The dry run is read-only: schema and indexes are only touched when applying.
  if (apply) await ensureCollections(db, specs);
  console.log(
    apply
      ? "Applying customers → users migration"
      : "Dry run (add --apply to write)",
  );
  console.log(await migrateCustomers(apply));
  await client.close();
}
