import type { Db, Document, IndexDescription } from "mongodb";

export type CollectionSpec = {
  name: string;
  validator: Document;
  indexes: IndexDescription[];
};

export async function ensureCollections(db: Db, specs: CollectionSpec[]) {
  const existing = new Set<string>();
  for await (const { name } of db.listCollections({}, { nameOnly: true })) {
    existing.add(name);
  }
  for (const { name, validator, indexes } of specs) {
    const options = {
      validator,
      validationLevel: "strict",
      validationAction: "error",
    } as const;
    if (existing.has(name)) await db.command({ collMod: name, ...options });
    else await db.createCollection(name, options);
    if (indexes.length > 0) await db.collection(name).createIndexes(indexes);
  }
}
