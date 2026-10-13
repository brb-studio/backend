import * as z from "zod";
import { slug } from "../tenancy/schemas";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const joinBody = z
  .strictObject({
    branch: slug,
    service: slug.optional(),
    package: slug.optional(),
    barber: slug.optional(),
    date: z.iso.date(),
    from: z.string().regex(HHMM).optional(),
    to: z.string().regex(HHMM).optional(),
  })
  .refine((b) => !b.service !== !b.package, {
    error: "ask for a service or a package",
  })
  .refine((b) => !b.from || !b.to || b.from < b.to, {
    path: ["to"],
    error: "must be after from",
  });
