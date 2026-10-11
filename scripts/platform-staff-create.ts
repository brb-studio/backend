import { parseArgs } from "node:util";
import { ObjectId } from "mongodb";
import * as z from "zod";
import { client, db } from "../src/db/client";
import { platformStaff, specs } from "../src/db/collections";
import { ensureCollections } from "../src/db/setup";

const { values } = parseArgs({
  options: { email: { type: "string" }, name: { type: "string" } },
});

const input = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email()),
    name: z.string().trim().min(2).max(80),
  })
  .parse(values);

const password = Buffer.from(
  crypto.getRandomValues(new Uint8Array(18)),
).toString("base64url");
const now = new Date();

await ensureCollections(db, specs);
await platformStaff.insertOne({
  _id: new ObjectId(),
  email: input.email,
  name: input.name,
  passwordHash: await Bun.password.hash(password),
  active: true,
  createdAt: now,
  updatedAt: now,
});
await client.close();

console.log(`Platform staff created in database "${db.databaseName}".
Email: ${input.email}
Password, shown only once, store it now: ${password}`);
