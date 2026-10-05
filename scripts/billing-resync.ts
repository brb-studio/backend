import { parseArgs } from "node:util";
import { client } from "../src/db/client";
import { syncSubscription } from "../src/features/billing/service";

const { values } = parseArgs({ options: { sub: { type: "string" } } });
if (!values.sub || !/^sub_/.test(values.sub)) {
  console.error("usage: bun scripts/billing-resync.ts --sub sub_...");
  process.exit(1);
}

await syncSubscription(values.sub);
await client.close();
console.log(`synced ${values.sub}`);
