import { ObjectId } from "mongodb";
import { client, db } from "../src/db/client";
import { branches, productStock, products, specs } from "../src/db/collections";
import { ensureCollections } from "../src/db/setup";

/**
 * Moves each product's single `stock` count onto one productStock row per branch it is sold at (its own
 * branch, or every active branch). Dry run unless --apply; rows that already exist are kept as they are.
 */
export async function migrateProductStock(apply: boolean, now = new Date()) {
  const report = { products: 0, rows: 0, kept: 0 };
  const counted = await products.find({ stock: { $exists: true } }).toArray();
  for (const product of counted) {
    report.products++;
    const stock = (product as { stock?: number }).stock ?? 0;
    const sites = product.branchId
      ? [product.branchId]
      : (
          await branches
            .find(
              { tenantId: product.tenantId, active: true },
              { projection: { _id: 1 } },
            )
            .toArray()
        ).map((b) => b._id);
    for (const branchId of sites) {
      const exists = await productStock.countDocuments({
        tenantId: product.tenantId,
        productId: product._id,
        branchId,
      });
      if (exists) {
        report.kept++;
        continue;
      }
      report.rows++;
      if (apply) {
        await productStock.insertOne({
          _id: new ObjectId(),
          tenantId: product.tenantId,
          productId: product._id,
          branchId,
          quantity: stock,
          updatedAt: now,
        });
      }
    }
    if (apply) {
      await products.updateOne({ _id: product._id }, { $unset: { stock: "" } });
    }
  }
  return report;
}

if (import.meta.main) {
  const apply = Bun.argv.includes("--apply");
  if (apply) await ensureCollections(db, specs);
  console.log(
    apply
      ? "Applying product stock migration"
      : "Dry run (add --apply to write)",
  );
  console.log(await migrateProductStock(apply));
  await client.close();
}
