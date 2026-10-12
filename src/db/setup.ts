import type { Db, Document, IndexDescription } from "mongodb";

export type CollectionSpec = {
  name: string;
  validator: Document;
  indexes: IndexDescription[];
  /** Index names a spec no longer uses; dropped on boot when they still exist. */
  dropIndexes?: string[];
};

export async function ensureCollections(db: Db, specs: CollectionSpec[]) {
  const existing = new Set<string>();
  for await (const { name } of db.listCollections({}, { nameOnly: true })) {
    existing.add(name);
  }
  for (const { name, validator, indexes, dropIndexes = [] } of specs) {
    const options = {
      validator,
      validationLevel: "strict",
      validationAction: "error",
    } as const;
    if (existing.has(name)) await db.command({ collMod: name, ...options });
    else await db.createCollection(name, options);
    const collection = db.collection(name);
    if (existing.has(name) && dropIndexes.length > 0) {
      for await (const index of collection.listIndexes()) {
        if (dropIndexes.includes(index.name)) {
          await collection.dropIndex(index.name);
        }
      }
    }
    if (indexes.length > 0) await collection.createIndexes(indexes);
  }
}
