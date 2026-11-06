/**
 * Local QA data in the dev database (`magicstudio`): three barbershops at three stages of use.
 *
 *   bun run seed:qa
 *
 * - MagicStudio (`magicstudio`): fully established, built with the showcase generator (months of
 *   agenda, cash, commissions, payouts, products, loyalty, waitlist, notifications…).
 * - Barbería Elite (`elite`): halfway through its setup, a few weeks of use.
 * - GhostBarber (`ghostbarber`): just created (trial + owner), to set up by hand.
 *
 * Every rerun wipes these three tenants and builds them again (anything added by hand is lost),
 * with the agenda moved to "now". Other tenants in the database are never touched.
 * Credentials: ../frontend/QA-CUENTAS.md (password for every account: demo1234).
 */
import type { ObjectId } from "mongodb";
import { config } from "../src/config";
import { client, db } from "../src/db/client";
import * as raw from "../src/db/collections";
import { migrateLedger } from "../src/db/ledger-backfill";
import { ensureCollections } from "../src/db/setup";
import { buildElite } from "./qa/elite";
import { buildGhost } from "./qa/ghost";

const PASSWORD = "demo1234";
const DEV_DB = "magicstudio";

// The showcase modules read who they are when first imported: set the brand before loading them.
Object.assign(process.env, {
  SHOWCASE_SLUG: "magicstudio",
  SHOWCASE_SHORT: "MagicStudio",
  SHOWCASE_NAME: "MagicStudio",
  SHOWCASE_PASSWORD: PASSWORD,
  // Every MagicStudio branch in Tijuana, the testers' own zone (Elite keeps another one on purpose).
  SHOWCASE_TIMEZONE: "America/Tijuana",
  SHOWCASE_PLACES: JSON.stringify({
    polanco: {
      name: "MagicStudio Zona Río",
      address: ["Paseo de los Héroes 9350", "Zona Río, Tijuana"],
      phone: "+526640000101",
    },
    providencia: {
      name: "MagicStudio Playas",
      address: ["Paseo Ensenada 1820", "Playas de Tijuana"],
      phone: "+526640000102",
    },
    sanpedro: {
      name: "MagicStudio Otay",
      address: ["Blvd. Industrial 2210", "Otay Universidad, Tijuana"],
      phone: "+526640000103",
    },
  }),
});
const { assertSafeTarget } = await import("./showcase/guard");
const { TENANT_ID } = await import("./showcase/ids");
const { seedShowcase } = await import("./showcase/write");

assertSafeTarget({
  nodeEnv: config.NODE_ENV,
  vercel: process.env.VERCEL || process.env.VERCEL_ENV,
  stripeKey: process.env.STRIPE_SECRET_KEY,
  mongoUrl: config.MONGO_URL,
  dbName: db.databaseName,
  allowDb: DEV_DB,
});

/** Deletes every document of the given tenants, in every collection. */
async function wipeTenants(ids: ObjectId[]) {
  if (ids.length === 0) return;
  for (const { name } of await db
    .listCollections({}, { nameOnly: true })
    .toArray()) {
    if (name.startsWith("system.")) continue;
    await db.collection(name).deleteMany({ tenantId: { $in: ids } });
  }
  await raw.tenants.deleteMany({ _id: { $in: ids } });
}

const now = new Date();
try {
  await ensureCollections(db, raw.specs);
  const stale = await raw.tenants
    .find(
      {
        $or: [
          { slug: { $in: ["elite", "ghostbarber"] } },
          // A MagicStudio left by `bun run seed` has another id: replace it with the full one.
          { slug: "magicstudio", _id: { $ne: TENANT_ID } },
        ],
      },
      { projection: { _id: 1 } },
    )
    .toArray();
  await wipeTenants(stale.map((t) => t._id));

  console.log(
    `Seeding QA data into "${db.databaseName}" (now = ${now.toISOString()})`,
  );
  const { counts } = await seedShowcase({ now, shared: true, allowDb: DEV_DB });
  console.log(
    `  MagicStudio   ${counts.appointments} citas, ${counts.users} usuarios`,
  );

  const passwordHash = await Bun.password.hash(PASSWORD);
  const elite = buildElite(now, passwordHash);
  const ghost = buildGhost(now, passwordHash);
  await client.withSession((session) =>
    session.withTransaction(async () => {
      const opts = { session };
      await raw.tenants.insertMany([elite.tenant, ghost.tenant], opts);
      await raw.branches.insertMany(elite.branches, opts);
      await raw.services.insertMany(elite.services, opts);
      await raw.packages.insertMany(elite.packages, opts);
      await raw.barbers.insertMany(elite.barbers, opts);
      await raw.users.insertMany([...elite.users, ...ghost.users], opts);
      await raw.promotions.insertMany(elite.promotions, opts);
      await raw.timeOff.insertMany(elite.timeOff, opts);
      await raw.appointments.insertMany(elite.appointments, opts);
    }),
  );
  await migrateLedger(true, [elite.tenant._id]);
  console.log(
    `  Elite         ${elite.appointments.length} citas, ${elite.users.length} usuarios`,
  );
  console.log("  GhostBarber   solo la barbería y su owner");
  console.log(
    `\nhttp://magicstudio.localhost:3000 · http://elite.localhost:3000 · http://ghostbarber.localhost:3000`,
  );
  console.log(
    `Cuentas en frontend/QA-CUENTAS.md. Contraseña de todas: ${PASSWORD}`,
  );
} finally {
  await client.close();
}
