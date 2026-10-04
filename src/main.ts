import { app } from "./app";
import { config } from "./config";
import { client, db } from "./db/client";
import { specs } from "./db/collections";
import { ensureCollections } from "./db/setup";

await ensureCollections(db, specs);

const server = Bun.serve({
  port: config.PORT,
  fetch: app.fetch,
  // Image uploads are up to 1 MB; JSON bodies stay capped at 64 KB by readJson.
  maxRequestBodySize: 1024 * 1024 + 64 * 1024,
  idleTimeout: 30,
});

console.log(`listening on ${server.url} (db: ${config.MONGO_DB})`);

async function shutdown(signal: string) {
  console.log(`${signal}: shutting down`);
  await server.stop();
  await client.close();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
