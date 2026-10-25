/**
 * Showcase barbershop for screenshots and demos: "Montecobre Barber Co." (fictional people, .test
 * emails, 55-0000 phones, licensed sample photos). Its own database, never the dev one:
 *
 *   MONGO_DB=brb-showcase bun run seed:showcase [--now 2026-10-23T12:30] [--shared]
 *
 * `--now` freezes the clock (an ISO instant, or a local "YYYY-MM-DDTHH:MM" read in Mexico City time).
 * Rerun right before taking screenshots: today's agenda, cash and waitlist are relative to "now".
 */
import { parseArgs } from "node:util";
import { config } from "../src/config";
import { client, db } from "../src/db/client";
import { isLocalDateTime, localToInstant } from "../src/shared/time";
import { assertSafeTarget, mongoHosts } from "./showcase/guard";
import { SLUG } from "./showcase/ids";
import { DOMAIN } from "./showcase/people";
import { DEMO_PASSWORD, seedShowcase } from "./showcase/write";

const { values } = parseArgs({
  options: {
    now: { type: "string" },
    shared: { type: "boolean", default: false },
  },
});

function parseNow(value: string | undefined) {
  if (!value) return new Date();
  if (isLocalDateTime(value))
    return localToInstant(value, "America/Mexico_City");
  const at = new Date(value);
  if (Number.isNaN(at.getTime()))
    throw new Error(`--now: "${value}" is not a date`);
  return at;
}

// Checked before anything connects; seedShowcase checks again, plus what the database holds.
assertSafeTarget({
  nodeEnv: config.NODE_ENV,
  vercel: process.env.VERCEL || process.env.VERCEL_ENV,
  stripeKey: process.env.STRIPE_SECRET_KEY,
  mongoUrl: config.MONGO_URL,
  dbName: db.databaseName,
});
const now = parseNow(values.now);
console.log(
  `Seeding "${SLUG}" into database "${db.databaseName}" on ${mongoHosts(config.MONGO_URL).join(",")} (now = ${now.toISOString()})`,
);

try {
  const { counts } = await seedShowcase({ now, shared: values.shared });
  console.log("\nDocuments of the showcase tenant:");
  for (const [name, count] of Object.entries(counts)) {
    console.log(`  ${name.padEnd(18)} ${count}`);
  }
  console.log(
    `\nMontecobre Barber Co. → http://${SLUG}.localhost:3000  (start the backend with MONGO_DB=${db.databaseName})`,
  );
  const accounts = [
    [
      "owner",
      `owner@${DOMAIN}`,
      "Ricardo Montes (also cuts at Polanco Tue–Thu)",
    ],
    ["admin", `admin@${DOMAIN}`, "Daniela Ferrer (no barber profile)"],
    [
      "manager",
      `polanco@${DOMAIN}, providencia@${DOMAIN}, sanpedro@${DOMAIN}`,
      "",
    ],
    [
      "barber",
      `emilio@ santiago@ iker@ rodrigo@ mauricio@ valeria@ andres@ joaquin@ luisfernando@ (${DOMAIN})`,
      "",
    ],
    [
      "customer",
      `cliente@${DOMAIN}`,
      "Sebastián Herrera (loyalty 4/6, 2 upcoming, 1 reserved order)",
    ],
  ];
  for (const [role, email, note] of accounts) {
    console.log(`  ${role?.padEnd(9)} ${email}${note ? `  ${note}` : ""}`);
  }
  console.log(
    `\nPassword for every showcase account (local only): ${DEMO_PASSWORD}`,
  );
} finally {
  await client.close();
}
