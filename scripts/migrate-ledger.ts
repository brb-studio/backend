import type { AnyBulkWriteOperation, ObjectId } from "mongodb";
import { client, db } from "../src/db/client";
import {
  type AppointmentDoc,
  appointments,
  barbers,
  branches,
  type LedgerEntryDoc,
  ledgerEntries,
  type PaymentDoc,
  payments,
  payouts,
  productOrders,
  specs,
} from "../src/db/collections";
import { ensureCollections } from "../src/db/setup";
import {
  counterEntry,
  type NewEntry,
  onlineEntry,
  paymentEntry,
  payoutEntry,
  saleEntry,
} from "../src/features/money/rules";

const BATCH = 500;
const hex = (id: ObjectId) => id.toHexString();

function writer(apply: boolean) {
  let pending: AnyBulkWriteOperation<LedgerEntryDoc>[] = [];
  const report = { entries: 0, inserted: 0 };
  const flush = async () => {
    if (apply && pending.length > 0) {
      const result = await ledgerEntries.bulkWrite(pending, { ordered: false });
      report.inserted += result.upsertedCount;
    }
    pending = [];
  };
  const put = async (tenantId: ObjectId, entry: NewEntry | undefined) => {
    if (!entry) return;
    report.entries++;
    pending.push({
      updateOne: {
        filter: { tenantId, source: entry.source },
        update: { $setOnInsert: { ...entry, tenantId } },
        upsert: true,
      },
    });
    if (pending.length >= BATCH) await flush();
  };
  return { put, flush, report };
}

const lastAt = (payment: PaymentDoc, status: PaymentDoc["status"]) =>
  payment.history.findLast((h) => h.status === status)?.at ??
  payment.history.at(-1)?.at ??
  payment.createdAt;

async function zonesOf() {
  const zones = new Map<string, string>();
  for await (const b of branches
    .find({})
    .project<{ _id: ObjectId; timeZone: string }>({ timeZone: 1 })) {
    zones.set(hex(b._id), b.timeZone);
  }
  return zones;
}

type Scope = { tenantId?: { $in: ObjectId[] } };

async function paymentEntries(
  put: (tenantId: ObjectId, entry: NewEntry | undefined) => Promise<void>,
  of: Scope,
) {
  let batch: PaymentDoc[] = [];
  const drain = async () => {
    const visits = new Map<string, AppointmentDoc>();
    for await (const a of appointments.find({
      _id: { $in: batch.map((p) => p.appointmentId) },
    })) {
      visits.set(hex(a._id), a);
    }
    for (const p of batch) {
      const visit = visits.get(hex(p.appointmentId));
      if (!visit || !p.resolvedAt) continue;
      await put(p.tenantId, paymentEntry(visit, p, p.resolvedAt, p.resolvedBy));
      const fee = p.stripe?.applicationFeeMinor ?? 0;
      if (fee > 0) {
        await put(
          p.tenantId,
          onlineEntry(
            visit,
            p,
            p.resolvedAt,
            "online_fee",
            fee,
            `fee:${hex(p._id)}`,
          ),
        );
      }
      const refunded = p.stripe?.refundedMinor ?? 0;
      if (refunded > 0) {
        await put(
          p.tenantId,
          onlineEntry(
            visit,
            p,
            lastAt(p, p.status === "refunded" ? "refunded" : "paid"),
            "refund",
            refunded,
            `refund:${hex(p._id)}:${refunded}`,
            { approximate: true },
          ),
        );
      }
      const disputeId = p.stripe?.disputeId;
      if (disputeId && p.amountMinor - refunded > 0) {
        await put(
          p.tenantId,
          onlineEntry(
            visit,
            p,
            lastAt(p, "disputed"),
            "chargeback",
            p.amountMinor - refunded,
            `dispute:${disputeId}`,
            { approximate: true },
          ),
        );
      }
    }
    batch = [];
  };
  for await (const p of payments.find({
    ...of,
    status: { $in: ["paid", "refunded", "disputed"] },
  })) {
    batch.push(p);
    if (batch.length >= BATCH) await drain();
  }
  await drain();
}

export async function migrateLedger(apply: boolean, tenantIds?: ObjectId[]) {
  const { put, flush, report } = writer(apply);
  const zones = await zonesOf();
  const of: Scope = tenantIds ? { tenantId: { $in: tenantIds } } : {};

  for await (const a of appointments.find({
    ...of,
    counter: { $exists: true },
  })) {
    if (a.counter) await put(a.tenantId, counterEntry(a, a.counter));
  }
  await paymentEntries(put, of);
  for await (const o of productOrders.find({
    ...of,
    status: "delivered",
    payment: { $exists: true },
  })) {
    if (!o.payment) continue;
    await put(
      o.tenantId,
      saleEntry(o, o.payment, zones.get(hex(o.branchId)) ?? "UTC"),
    );
  }
  for await (const p of payouts.find(of)) {
    const barber = await barbers.findOne(
      { _id: p.barberId },
      { projection: { branchId: 1, name: 1 } },
    );
    if (!barber) continue;
    await put(
      p.tenantId,
      payoutEntry(p, barber, zones.get(hex(barber.branchId)) ?? "UTC"),
    );
  }
  await flush();
  return report;
}

if (import.meta.main) {
  const apply = Bun.argv.includes("--apply");
  if (apply) await ensureCollections(db, specs);
  console.log(
    apply ? "Applying ledger migration" : "Dry run (add --apply to write)",
  );
  console.log(await migrateLedger(apply));
  await client.close();
}
