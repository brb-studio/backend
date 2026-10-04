import { beforeAll, describe, expect, test } from "bun:test";
import { app } from "../src/app";
import { client, db } from "../src/db/client";
import { type CollectionSpec, ensureCollections } from "../src/db/setup";

const probe: CollectionSpec = {
  name: "setup_probe",
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["n"],
      properties: { n: { bsonType: "int", minimum: 0 } },
    },
  },
  indexes: [{ key: { n: 1 }, name: "n_unique", unique: true }],
};

beforeAll(async () => {
  await db.createCollection("tx_probe");
});

describe("database", () => {
  test("GET /health pings MongoDB", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("ensureCollections is idempotent and enforces validator + unique index", async () => {
    await ensureCollections(db, [probe]);
    await ensureCollections(db, [probe]);

    const coll = db.collection(probe.name);
    await coll.insertOne({ n: 1 });
    await expect(coll.insertOne({ n: 1 })).rejects.toMatchObject({
      code: 11000,
    });
    await expect(coll.insertOne({ n: 1.5 })).rejects.toMatchObject({
      code: 121,
    });
    await expect(coll.insertOne({ n: -1 })).rejects.toMatchObject({
      code: 121,
    });
    await expect(coll.insertOne({ m: 1 })).rejects.toMatchObject({
      code: 121,
    });
  });

  test("transactions commit all-or-nothing", async () => {
    const coll = db.collection<{ _id: string }>("tx_probe");

    await client.withSession((session) =>
      session.withTransaction(async () => {
        await coll.insertOne({ _id: "a" }, { session });
        await coll.insertOne({ _id: "b" }, { session });
      }),
    );
    await expect(
      client.withSession((session) =>
        session.withTransaction(async () => {
          await coll.insertOne({ _id: "c" }, { session });
          throw new Error("abort");
        }),
      ),
    ).rejects.toThrow("abort");

    const ids = await coll
      .find()
      .sort({ _id: 1 })
      .map((doc) => doc._id)
      .toArray();
    expect(ids).toEqual(["a", "b"]);
  });
});
