import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGO_URL!);
await client.db(process.env.MONGO_DB).collection("ownerProject").insertOne({
  email: "dueno@plataforma.test",
  name: "Plataforma Pruebas",
  role: "owner",
  active: true,
  bankAccountKey: "002010077777777771",
});
await client.close();
console.log("ok");