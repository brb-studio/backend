import type { Db, Document, IndexDescription } from "mongodb";

export type CollectionSpec = {
  name: string;
  validator: Document;
  indexes: IndexDescription[];
};

export async function ensureCollections(db: Db, specs: CollectionSpec[]) {
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map(
      (collection) => collection.name,
    ),
  );
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
