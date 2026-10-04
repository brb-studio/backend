import { parseArgs } from "node:util";
import { ObjectId } from "mongodb";
import * as z from "zod";
import { client, db } from "../src/db/client";
import { PLANS, specs, tenants, users } from "../src/db/collections";
import { ensureCollections } from "../src/db/setup";
import { slug } from "../src/features/tenancy/schemas";
import { PLAN_LIMITS } from "../src/features/tenancy/subscription";

const { values } = parseArgs({
  options: {
    slug: { type: "string" },
    name: { type: "string" },
    plan: { type: "string", default: "trial" },
    currency: { type: "string", default: "MXN" },
    domain: { type: "string" },
    "owner-email": { type: "string" },
    "owner-name": { type: "string" },
  },
});

const input = z
  .object({
    slug,
    name: z.string().trim().min(1).max(80),
    plan: z.enum(PLANS),
    currency: z.string().regex(/^[A-Z]{3}$/),
    domain: z
      .string()
      .toLowerCase()
      .regex(/^[a-z0-9]+([.-][a-z0-9]+)+$/)
      .optional(),
    "owner-email": z.string().trim().toLowerCase().pipe(z.email()),
    "owner-name": z.string().trim().min(2).max(80),
  })
  .parse(values);

const TRIAL_DAYS = 14;
const now = new Date();
const password = Buffer.from(
  crypto.getRandomValues(new Uint8Array(18)),
).toString("base64url");
const passwordHash = await Bun.password.hash(password);
const tenantId = new ObjectId();

await ensureCollections(db, specs);
await client.withSession((session) =>
  session.withTransaction(async () => {
    await tenants.insertOne(
      {
        _id: tenantId,
        slug: input.slug,
        name: input.name,
        ...(input.domain && { customDomain: input.domain }),
        currency: input.currency,
        locales: ["es", "en"],
        defaultLocale: "es",
        brand: {},
        subscription: {
          plan: input.plan,
          status: input.plan === "trial" ? "trialing" : "active",
          ...(input.plan === "trial" && {
            currentPeriodEnd: new Date(now.getTime() + TRIAL_DAYS * 864e5),
          }),
          limits: PLAN_LIMITS[input.plan],
        },
        createdAt: now,
        updatedAt: now,
      },
      { session },
    );
    await users.insertOne(
      {
        _id: new ObjectId(),
        tenantId,
        email: input["owner-email"],
        name: input["owner-name"],
        role: "owner",
        active: true,
        passwordHash,
        createdAt: now,
        updatedAt: now,
      },
      { session },
    );
  }),
);
await client.close();

console.log(`Tenant "${input.slug}" created (${input.plan}) in database "${db.databaseName}".
Owner: ${input["owner-email"]}
Password, shown only once, store it now: ${password}`);
