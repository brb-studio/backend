import { ObjectId } from "mongodb";
import type * as z from "zod";
import { forTenant, type TenantDoc } from "../../db/scoped";
import { AppError, type Auth, isDuplicate } from "../../shared/http";
import { localDate } from "../../shared/time";
import type { NewEntry } from "./rules";
import type { entryBody } from "./schemas";

const notFound = () => new AppError(404, "NOT_FOUND", "Not found");

export async function createEntry(
  tenant: Pick<TenantDoc, "_id" | "currency">,
  auth: Auth,
  input: z.output<typeof entryBody>,
) {
  const t = forTenant(tenant._id);
  const now = new Date();
  let entry: NewEntry;
  if ("reverses" in input) {
    const original = await t.ledgerEntries.findOne({ _id: input.reverses });
    if (!original) throw notFound();
    if (original.reverses) {
      throw new AppError(
        409,
        "NOT_REVERSIBLE",
        "A reversal can't be reversed; add a new adjustment instead",
      );
    }
    const branch = await t.branches.findOne(
      { _id: original.branchId },
      { projection: { timeZone: 1 } },
    );
    const _id = new ObjectId();
    entry = {
      _id,
      branchId: original.branchId,
      source: `manual:${_id.toHexString()}`,
      at: now,
      localDate: localDate(now, branch?.timeZone ?? "UTC"),
      direction: original.direction === "in" ? "out" : "in",
      type: "adjustment",
      ...(original.method && { method: original.method }),
      amountMinor: original.amountMinor,
      currency: original.currency,
      concept: original.concept,
      recordedBy: auth.userId,
      reverses: original._id,
      note: input.note,
      createdAt: now,
    };
  } else {
    const branch = await t.branches.findOne(
      { _id: input.branchId },
      { projection: { timeZone: 1 } },
    );
    if (!branch) throw notFound();
    const _id = new ObjectId();
    entry = {
      _id,
      branchId: input.branchId,
      source: `manual:${_id.toHexString()}`,
      at: now,
      localDate: localDate(now, branch.timeZone),
      direction: input.type === "expense" ? "out" : input.direction,
      type: input.type,
      method: input.method,
      amountMinor: input.amountMinor,
      currency: tenant.currency,
      concept: input.concept,
      recordedBy: auth.userId,
      ...(input.reference && { reference: input.reference }),
      ...(input.note && { note: input.note }),
      createdAt: now,
    };
  }
  try {
    await t.ledgerEntries.insertOne(entry);
  } catch (err) {
    if (isDuplicate(err)) {
      throw new AppError(409, "ALREADY_REVERSED", "Already reversed");
    }
    throw err;
  }
  return {
    id: entry._id.toHexString(),
    at: entry.at,
    localDate: entry.localDate,
    direction: entry.direction,
    type: entry.type,
    amountMinor: entry.amountMinor,
    concept: entry.concept,
    ...(entry.method && { method: entry.method }),
    ...(entry.reverses && { reverses: entry.reverses.toHexString() }),
    ...(entry.note && { note: entry.note }),
    ...(entry.reference && { reference: entry.reference }),
  };
}
