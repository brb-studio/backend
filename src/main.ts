import { app, dbReady } from "./app";
import { config } from "./config";
import { client } from "./db/client";
import { runDigests } from "./features/platform/digest";

await dbReady();

const server = Bun.serve({
  port: config.PORT,
  fetch: app.fetch,
  maxRequestBodySize: 1024 * 1024 + 64 * 1024,
  idleTimeout: 30,
});

// A long-running server keeps its own clock; on serverless a scheduler calls GET /cron/digest instead.
const digestTimer = setInterval(
  () =>
    void runDigests().catch((err: unknown) =>
      console.error(`digest failed: ${String(err)}`),
    ),
  10 * 60 * 1000,
);

console.log(`listening on ${server.url} (db: ${config.MONGO_DB})`);

async function shutdown(signal: string) {
  console.log(`${signal}: shutting down`);
  clearInterval(digestTimer);
  await server.stop();
  await client.close();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
