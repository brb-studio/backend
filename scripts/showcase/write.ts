import type { ClientSession, Collection, Filter, ObjectId } from "mongodb";
import { config } from "../../src/config";
import { client, db } from "../../src/db/client";
import * as raw from "../../src/db/collections";
import { ensureCollections } from "../../src/db/setup";
import {
  buildNotifications,
  buildPayouts,
  buildProductOrders,
  buildWaitlist,
} from "./activity";
import { buildAgenda } from "./agenda";
import { buildCatalog } from "./catalog";
import { closeVisits } from "./counter";
import { assertSafeTarget, checkDatabase } from "./guard";
import { TENANT_ID } from "./ids";
import { loadImages } from "./images";
import { applyPromotions } from "./loyalty";
import { buildPeople } from "./people";
import { buildTimeOff } from "./timeoff";

export const DEMO_PASSWORD = "montecobre-demo";

type Owned = { _id: ObjectId | string; tenantId: ObjectId };

/**
 * Every write of the seed goes through here: `tenantId` is forced into each filter (the script's
 * mirror of `forTenant`), and a document of another tenant is refused before it reaches the driver.
 */
function own<T extends Owned>(
  collection: Collection<T>,
  session?: ClientSession,
) {
  const mine = (filter: Filter<T> = {}) =>
    ({ ...filter, tenantId: TENANT_ID }) as Filter<T>;
  const check = (docs: T[]) => {
    for (const d of docs) {
      if (!d.tenantId.equals(TENANT_ID))
        throw new Error(
          `refusing a document of another tenant in ${collection.collectionName}`,
        );
    }
  };
  return {
    wipe: () => collection.deleteMany(mine(), { session }),
    prune: (keep: T["_id"][]) =>
      collection.deleteMany(mine({ _id: { $nin: keep } } as Filter<T>), {
        session,
      }),
    upsert: async (docs: T[]) => {
      check(docs);
      if (docs.length === 0) return;
      await collection.bulkWrite(
        docs.map((doc) => ({
          replaceOne: {
            filter: mine({ _id: doc._id } as Filter<T>),
            replacement: doc,
            upsert: true,
          },
        })),
        { session, ordered: true },
      );
    },
    count: () => collection.countDocuments(mine()),
  };
}

/** Documents of the showcase tenant per collection (identical after every rerun with the same `now`). */
export async function countShowcase() {
  const n = <T extends Owned>(c: Collection<T>) => own(c).count();
  return {
    tenants: await raw.tenants.countDocuments({ _id: TENANT_ID }),
    branches: await n(raw.branches),
    users: await n(raw.users),
    barbers: await n(raw.barbers),
    services: await n(raw.services),
    packages: await n(raw.packages),
    products: await n(raw.products),
    promotions: await n(raw.promotions),
    images: await n(raw.images),
    appointments: await n(raw.appointments),
    timeOff: await n(raw.timeOff),
    notifications: await n(raw.notifications),
    waitlist: await n(raw.waitlist),
    productOrders: await n(raw.productOrders),
    productStock: await n(raw.productStock),
    payouts: await n(raw.payouts),
    payments: await n(raw.payments),
    pushSubscriptions: await n(raw.pushSubscriptions),
    authTokens: await n(raw.authTokens),
  };
}
export type Counts = Awaited<ReturnType<typeof countShowcase>>;

/** Builds the whole shop in memory: pure apart from reading the sample photos. */
export async function buildShowcase(now: Date) {
  const passwordHash = await Bun.password.hash(DEMO_PASSWORD, {
    algorithm: "argon2id",
  });
  const people = buildPeople(now, passwordHash);
  const images = loadImages(people.ids.owner, now);
  const catalog = buildCatalog(now, images.refs);
  const timeOff = buildTimeOff(catalog, people, now);
  const bookings = buildAgenda(catalog, people, timeOff, now);
  const redemptions = applyPromotions(bookings, catalog.promotions);
  for (const p of catalog.promotions)
    p.redemptions = redemptions.get(p._id.toHexString()) ?? 0;
  closeVisits(bookings, {
    now,
    branches: catalog.branches,
    barbers: people.barbers,
    managers: people.managers,
  });
  const appointments = bookings.map((b) => b.doc);
  const ctx = { catalog, people, now };
  const payouts = buildPayouts(appointments, ctx);
  return {
    catalog,
    people,
    images: images.docs,
    timeOff,
    appointments,
    payouts,
    notifications: buildNotifications(appointments, ctx),
    waitlist: buildWaitlist(ctx),
    productOrders: buildProductOrders(ctx),
  };
}

/**
 * Seeds (or refreshes) the showcase barbershop. Idempotent: stable documents keep deterministic ids
 * and are upserted, anything else of the tenant is pruned; time-relative documents (agenda, cash,
 * notifications…) are deleted and inserted again in one transaction, so a rerun "moves the shop to now".
 */
export async function seedShowcase(
  options: { now?: Date; shared?: boolean } = {},
) {
  const now = options.now ?? new Date();
  assertSafeTarget({
    nodeEnv: config.NODE_ENV,
    vercel: process.env.VERCEL || process.env.VERCEL_ENV,
    stripeKey: process.env.STRIPE_SECRET_KEY,
    mongoUrl: config.MONGO_URL,
    dbName: db.databaseName,
  });
  await checkDatabase(raw.tenants, db.databaseName, options.shared ?? false);
  await ensureCollections(db, raw.specs);
  const shop = await buildShowcase(now);
  const { catalog, people } = shop;

  // Photos: written only when missing (they never change), outside the transaction.
  const images = own(raw.images);
  await images.prune(shop.images.map((i) => i._id));
  const present = new Set(
    (
      await raw.images
        .find({ tenantId: TENANT_ID }, { projection: { _id: 1 } })
        .toArray()
    ).map((i) => i._id),
  );
  await images.upsert(shop.images.filter((i) => !present.has(i._id)));

  await client.withSession((session) =>
    session.withTransaction(
      async () => {
        const o = <T extends Owned>(c: Collection<T>) => own(c, session);
        // Time-relative first, so nothing points at a pruned document and live slots never clash.
        // They are then written back with the same upsert (into emptied collections, i.e. inserts).
        await o(raw.payouts).wipe();
        await o(raw.notifications).wipe();
        await o(raw.waitlist).wipe();
        await o(raw.productOrders).wipe();
        await o(raw.timeOff).wipe();
        await o(raw.payments).wipe();
        await o(raw.pushSubscriptions).wipe();
        await o(raw.authTokens).wipe();
        await o(raw.appointments).wipe();
        await raw.tenants.replaceOne({ _id: TENANT_ID }, catalog.tenant, {
          upsert: true,
          session,
        });
        const stable = async <T extends Owned>(c: Collection<T>, docs: T[]) => {
          await o(c).prune(docs.map((d) => d._id));
          await o(c).upsert(docs);
        };
        await stable(raw.branches, catalog.branches);
        await stable(raw.services, catalog.services);
        await stable(raw.packages, catalog.packages);
        await stable(raw.products, catalog.products);
        await stable(raw.productStock, catalog.productStock);
        await stable(raw.promotions, catalog.promotions);
        await stable(raw.users, people.users);
        await stable(raw.barbers, people.barbers);
        await o(raw.timeOff).upsert(shop.timeOff);
        await o(raw.appointments).upsert(shop.appointments);
        await o(raw.payouts).upsert(shop.payouts);
        await o(raw.notifications).upsert(shop.notifications);
        await o(raw.waitlist).upsert(shop.waitlist);
        await o(raw.productOrders).upsert(shop.productOrders);
      },
      { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
    ),
  );
  return { now, counts: await countShowcase(), shop };
}
