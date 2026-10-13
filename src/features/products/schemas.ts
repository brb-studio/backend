import * as z from "zod";
import { PRODUCT_PAYMENT_METHODS } from "../../db/scoped";
import { images, localized, slug } from "../tenancy/schemas";
import { MAX_LINES, MAX_QUANTITY } from "./rules";

const money = z.int().min(0).max(10_000_000);
const category = z.string().trim().min(1).max(40);
const stock = z.int().min(0).max(1_000_000);

const common = {
  slug,
  name: localized(80),
  description: localized(500),
  images,
  priceMinor: money,
  position: z.int().min(0).max(10_000),
};

export const productCreate = z.strictObject({
  ...common,
  description: common.description.optional(),
  images: common.images.optional(),
  position: common.position.default(0),
  branchId: z
    .string()
    .regex(/^[a-f\d]{24}$/)
    .optional(),
  category: category.optional(),
  stock: stock.optional(),
});

export const productUpdate = z
  .strictObject({
    ...z.object(common).partial().shape,
    category: category.nullable().optional(),
    stock: stock.nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    error: "nothing to update",
  });

export const reserveBody = z.strictObject({
  branch: slug,
  items: z
    .array(
      z.strictObject({
        product: slug,
        quantity: z.int().min(1).max(MAX_QUANTITY),
      }),
    )
    .min(1)
    .max(MAX_LINES),
});

export const scanBody = z.strictObject({ code: z.string().max(100) });

export const deliverBody = z.strictObject({
  method: z.enum(PRODUCT_PAYMENT_METHODS),
});

export const publicQuery = z.object({ branch: slug.optional() });
