import { afterAll, beforeAll } from "bun:test";
import { client, db } from "../src/db/client";
import { specs } from "../src/db/collections";
import { ensureCollections } from "../src/db/setup";

beforeAll(async () => {
  if (!db.databaseName.endsWith("_test")) {
    throw new Error(`refusing to drop ${db.databaseName}`);
  }
  await db.dropDatabase();
  await ensureCollections(db, specs);
});

afterAll(() => client.close());
