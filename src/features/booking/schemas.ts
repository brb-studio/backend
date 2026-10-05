import * as z from "zod";
import { objectId } from "../../shared/http";
import { email } from "../auth/schemas";
import { code } from "../promotions/schemas";
import { slug } from "../tenancy/schemas";

export const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{7,20}$/, "enter a valid phone number")
  .transform((value) => value.replace(/[ ()-]/g, ""))
  .pipe(z.string().regex(/^\+?\d{7,15}$/, "enter a valid phone number"));

const instant = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));

export const guest = z.strictObject({
  name: z.string().trim().min(2).max(80),
  phone,
  email: email.optional(),
});

const notes = z.string().trim().min(1).max(500);

const oneOf = (input: { service?: unknown; package?: unknown }) =>
  !input.service !== !input.package;

export const publicBooking = z
  .strictObject({
    branch: slug,
    barber: slug,
    service: slug.optional(),
    package: slug.optional(),
    startAt: instant,
    customer: guest.optional(),
    code: code.optional(),
    notes: notes.optional(),
  })
  .refine(oneOf, { error: "book a service or a package" });

export const publicQuote = z
  .strictObject({
    branch: slug,
    service: slug.optional(),
    package: slug.optional(),
    code: code.optional(),
    phone: phone.optional(),
  })
  .refine(oneOf, { error: "quote a service or a package" });

export const staffBooking = z
  .strictObject({
    branchId: objectId,
    barberId: objectId,
    serviceId: objectId.optional(),
    packageId: objectId.optional(),
    startAt: instant,
    customerId: objectId.optional(),
    customer: guest.optional(),
    code: code.optional(),
    notes: notes.optional(),
  })
  .refine((b) => !b.serviceId !== !b.packageId, {
    error: "book a service or a package",
  })
  .refine((b) => !b.customerId !== !b.customer, {
    error: "send customerId or customer",
  });

export const appointmentUpdate = z
  .strictObject({
    status: z.enum(["completed", "cancelled", "no_show"]).optional(),
    startAt: instant.optional(),
    barberId: objectId.optional(),
    notes: notes.optional(),
    cancelReason: z.string().trim().min(1).max(200).optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    error: "nothing to update",
  })
  .refine((input) => !input.status || (!input.startAt && !input.barberId), {
    error: "change the status or reschedule, not both",
  });

export const appointmentRange = z
  .object({
    branchId: objectId.optional(),
    barberId: objectId.optional(),
    from: instant.optional(),
    to: instant.optional(),
  })
  .refine(
    (r) =>
      !r.from ||
      !r.to ||
      (r.from < r.to && r.to.getTime() - r.from.getTime() <= 62 * 864e5),
    { error: "to must be after from, at most 62 days apart" },
  );

export const rescheduleMineBody = z.strictObject({ startAt: instant });

export const rescheduleSlotsQuery = z.object({
  from: z.iso.date().optional(),
  days: z.coerce.number().int().min(1).max(31).optional(),
});
