import * as z from "zod";
import { objectId } from "../../shared/http";
import { images, localized, slug } from "../tenancy/schemas";

const money = z.int().min(0).max(10_000_000);
const durationMin = z.int().min(5).max(720);
const items = z
  .array(z.strictObject({ serviceId: objectId }))
  .min(2)
  .max(10);

const common = {
  slug,
  name: localized(80),
  description: localized(500),
  images,
  position: z.int().min(0).max(10_000),
};

const nonEmpty = (input: object) => Object.keys(input).length > 0;

export const serviceCreate = z.strictObject({
  ...common,
  description: common.description.optional(),
  images: common.images.optional(),
  position: common.position.default(0),
  branchId: objectId.optional(),
  durationMin,
  priceMinor: money,
});

export const serviceUpdate = z
  .strictObject({
    ...z.object({ ...common, durationMin, priceMinor: money }).partial().shape,
    active: z.boolean().optional(),
  })
  .refine(nonEmpty, { error: "nothing to update" });

export const packageCreate = z.strictObject({
  ...common,
  description: common.description.optional(),
  images: common.images.optional(),
  position: common.position.default(0),
  branchId: objectId.optional(),
  priceMinor: money,
  items,
});

export const packageUpdate = z
  .strictObject({
    ...z.object({ ...common, priceMinor: money, items }).partial().shape,
    active: z.boolean().optional(),
  })
  .refine(nonEmpty, { error: "nothing to update" });
