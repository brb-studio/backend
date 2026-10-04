import { MongoClient } from "mongodb";
import { config } from "../config";

export const client = new MongoClient(config.MONGO_URL, {
  appName: "magicstudio-backend",
  serverSelectionTimeoutMS: 5_000,
  ignoreUndefined: true,
});

export const db = client.db(config.MONGO_DB);
