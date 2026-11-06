import { isDuplicate } from "../shared/http";
import { db } from "./client";
import type { CollectionSpec } from "./setup";
import { date, object, string } from "./validators";

export type OneTimeJobDoc = {
  _id: string;
  startedAt: Date;
  doneAt?: Date;
  result?: string;
};

export const oneTimeJobs = db.collection<OneTimeJobDoc>("oneTimeJobs");

export const oneTimeJobSpecs: CollectionSpec[] = [
  {
    name: "oneTimeJobs",
    validator: {
      $jsonSchema: object(["_id", "startedAt"], {
        _id: string({ minLength: 1, maxLength: 100 }),
        startedAt: date,
        doneAt: date,
        result: string({ maxLength: 2000 }),
      }),
    },
    indexes: [],
  },
];

const STALE_MS = 15 * 60 * 1000;

export async function runOnce(
  name: string,
  job: () => Promise<unknown>,
  now = new Date(),
) {
  try {
    await oneTimeJobs.updateOne(
      {
        _id: name,
        doneAt: { $exists: false },
        startedAt: { $lt: new Date(now.getTime() - STALE_MS) },
      },
      { $set: { startedAt: now } },
      { upsert: true },
    );
  } catch (err) {
    if (isDuplicate(err)) return false;
    throw err;
  }
  try {
    const result = await job();
    await oneTimeJobs.updateOne(
      { _id: name },
      {
        $set: {
          doneAt: new Date(),
          result: JSON.stringify(result ?? null).slice(0, 2000),
        },
      },
    );
    return true;
  } catch (err) {
    await oneTimeJobs.deleteOne({ _id: name, doneAt: { $exists: false } });
    throw err;
  }
}
