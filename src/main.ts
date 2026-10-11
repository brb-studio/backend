import { app, dbReady } from "./app";
import { config } from "./config";
import { client } from "./db/client";

await dbReady();

const server = Bun.serve({
  port: config.PORT,
  fetch: app.fetch,
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
