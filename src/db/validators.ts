import type { Document } from "mongodb";

/** Building blocks for the `$jsonSchema` validators every collection applies on boot. */
export const string = (extra: Document = {}) => ({
  bsonType: "string",
  ...extra,
});
export const int = (minimum: number, maximum: number) => ({
  bsonType: "int",
  minimum,
  maximum,
});
export const objectId = { bsonType: "objectId" };
export const date = { bsonType: "date" };
export const bool = { bsonType: "bool" };
export const oneOf = (values: readonly string[]) => ({ enum: [...values] });
export const object = (required: string[], properties: Document) => ({
  bsonType: "object",
  required,
  properties,
});
export const CURRENCY = string({ pattern: "^[A-Z]{3}$" });
export const MONEY = int(0, 100_000_000);
export const REFERRAL_CODE = "^[A-HJ-NP-Z2-9]{8}$";
