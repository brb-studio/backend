import { MongoClient } from "mongodb";

const url = process.env.MONGO_URL;
if (!url) throw new Error("MONGO_URL is required");
const client = new MongoClient(url);
await client.db(process.env.MONGO_DB).collection("ownerProject").insertOne({
  email: "dueno@plataforma.test",
  name: "Plataforma Pruebas",
  role: "owner",
  active: true,
  bankAccountKey: "002010077777777771",
});
await client.close();
console.log("ok");
