import { client, db } from "../src/db/client";
import { specs } from "../src/db/collections";
import { migrateLedger } from "../src/db/ledger-backfill";
import { ensureCollections } from "../src/db/setup";

const apply = Bun.argv.includes("--apply");
if (apply) await ensureCollections(db, specs);
console.log(
  apply ? "Applying ledger migration" : "Dry run (add --apply to write)",
);
console.log(await migrateLedger(apply));
await client.close();
