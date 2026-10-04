import * as z from "zod";
import { objectId } from "../../shared/http";

export const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const password = z.string().min(8).max(128);
const name = z.string().trim().min(2).max(80);

export const registerSchema = z.strictObject({
  name,
  email,
  phone: z
    .string()
    .trim()
    .regex(/^(\+?[0-9 ()-]{7,20})?$/)
    .transform((phone) => phone.replace(/[ ()-]/g, "") || undefined)
    .optional(),
  password,
});

export const loginSchema = z.strictObject({
  email,
  password: z.string().min(1).max(128),
});

export const passwordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(128),
  newPassword: password,
});

export const STAFF_ROLES = ["admin", "manager", "barber"] as const;

export const staffCreate = z
  .strictObject({
    name,
    email,
    role: z.enum(STAFF_ROLES),
    branchId: objectId.optional(),
  })
  .refine((s) => (s.role === "admin") === !s.branchId, {
    path: ["branchId"],
    error: "required for managers and barbers, not allowed for admins",
  });

export const staffUpdate = z
  .strictObject({
    name: name.optional(),
    role: z.enum(STAFF_ROLES).optional(),
    branchId: objectId.optional(),
    active: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    error: "nothing to update",
  });
