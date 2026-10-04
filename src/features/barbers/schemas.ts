import * as z from "zod";
import { TIME_OFF_KINDS } from "../../db/scoped";
import { objectId } from "../../shared/http";
import { isLocalDateTime } from "../../shared/time";
import { hours, images, localized, slug } from "../tenancy/schemas";

const barberFields = {
  slug,
  name: z.string().trim().min(1).max(80),
  specialty: localized(80),
  bio: localized(500),
  images,
  hours,
  serviceIds: z.array(objectId).max(100),
};

export const barberCreate = z.strictObject({
  ...barberFields,
  branchId: objectId,
  specialty: barberFields.specialty.optional(),
  bio: barberFields.bio.optional(),
  images: barberFields.images.optional(),
  hours: barberFields.hours.optional(),
  serviceIds: barberFields.serviceIds.optional(),
  userId: objectId.optional(),
});

export const barberUpdate = z
  .strictObject({
    ...z.object(barberFields).partial().shape,
    active: z.boolean().optional(),
    userId: objectId.nullable().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    error: "nothing to update",
  });

const localDateTime = z
  .string()
  .refine(isLocalDateTime, { error: "must be YYYY-MM-DDTHH:MM" });

export const timeOffCreate = z
  .strictObject({
    barberId: objectId.optional(),
    branchId: objectId.optional(),
    start: localDateTime,
    end: localDateTime,
    kind: z.enum(TIME_OFF_KINDS),
    reason: z.string().trim().min(1).max(200).optional(),
  })
  .refine((t) => !t.barberId !== !t.branchId, {
    error:
      "send barberId for one barber, or branchId to close the whole branch",
  })
  .refine((t) => (t.kind === "closure") === !t.barberId, {
    path: ["kind"],
    error: "closure is for whole-branch blocks only",
  })
  .refine((t) => t.start < t.end, {
    path: ["end"],
    error: "must be after start",
  });
