import { type ClientSession, type Filter, ObjectId } from "mongodb";
import type * as z from "zod";
import { hit } from "../../db/rate-limit";
import {
  type AppointmentDoc,
  type BarberDoc,
  type BranchDoc,
  type CustomerDoc,
  forTenant,
  type PaymentDoc,
  type TenantDb,
  type TenantDoc,
  transaction,
} from "../../db/scoped";
import { collect } from "../../shared/cursor";
import { AppError, type Auth, isDuplicate } from "../../shared/http";
import { photos } from "../../shared/photos";
import { visibleBranchIds } from "../auth/policy";
import { getUser } from "../auth/service";
import { freeSlots, isBookable, localDate } from "../availability/engine";
import {
  bookableDates,
  engineInput,
  STAFF_WINDOW_DAYS,
  scheduleOf,
  spanOf,
} from "../availability/service";
import { ownBarberId } from "../barbers/service";
import { canServe, type Request } from "../catalog/rules";
import { resolveRequest } from "../catalog/service";
import { notifyBarber, pushAfterCommit } from "../notifications/service";
import { startCharge } from "../payments/checkout";
import { holdMinutes, onlinePaymentsReady } from "../payments/connect";
import {
  type HoldRequest,
  onlineCurrencyFor,
  onlineOptions,
  planPayment,
  summaryOf,
} from "../payments/holds";
import { holdEnds, transferFits } from "../payments/rules";
import { cancelHold, refundAfterCancel, sweepHolds } from "../payments/settle";
import { resolveCommission } from "../platform/commission";
import { priceFor, redeem, release } from "../promotions/service";
import { getBranch } from "../tenancy/service";
import { customerForGuest, customerForUser, findCustomer } from "./customers";
import {
  bookedMinutes,
  bookedServiceIds,
  MAX_DURATION_MIN,
  snapshot,
} from "./order";
import type {
  appointmentRange,
  appointmentUpdate,
  publicBooking,
  publicQuote,
  staffBooking,
} from "./schemas";
import { customerView, lookups, staffViews } from "./views";

const HOUR_MS = 60 * 60 * 1000;
const notFound = () => new AppError(404, "NOT_FOUND", "Not found");
const forbidden = () => new AppError(403, "FORBIDDEN", "Not allowed");
const slotTaken = () =>
  new AppError(409, "SLOT_TAKEN", "That time is no longer free");
const notConfirmed = () =>
  new AppError(409, "NOT_CONFIRMED", "Only confirmed appointments can change");
const tooMany = () =>
  new AppError(429, "RATE_LIMITED", "Too many attempts, try again later");

function insideWindow(
  branch: BranchDoc,
  startAt: Date,
  now: number,
  days: number,
) {
  const date = localDate(startAt, branch.timeZone);
  const [first] = bookableDates(branch.timeZone, now, days, {
    from: date,
    days: 1,
  }).dates;
  return first === date;
}

async function assertFree(
  t: TenantDb,
  branch: BranchDoc,
  barber: BarberDoc,
  startAt: Date,
  durationMin: number,
  earliest: number,
  session: ClientSession,
  except?: ObjectId,
) {
  const span = spanOf([localDate(startAt, branch.timeZone)], branch.timeZone);
  if (!span) throw slotTaken();
  const schedule = (
    await scheduleOf(t, branch, [barber._id], span, { session, except })
  )(barber._id);
  const input = engineInput(branch, barber, durationMin, earliest, schedule);
  if (!isBookable(input, startAt)) throw slotTaken();
}

const lockBarber = (
  t: TenantDb,
  filter: { _id: ObjectId; branchId: ObjectId },
  session: ClientSession,
) =>
  t.barbers.findOneAndUpdate(
    { ...filter, active: true },
    { $inc: { lockVersion: 1 } },
    { session, returnDocument: "after" },
  );

type Placement = {
  branch: BranchDoc;
  barberId: ObjectId;
  request: Request;
  startAt: Date;
  customer: CustomerDoc;
  code?: string;
  notes?: string;
  source: "online" | "staff";
  createdBy?: ObjectId;
  now: number;
  /** Online bookings only: whether the shop takes online payments, and what the customer chose to pay. */
  online?: boolean;
  hold?: HoldRequest;
};

async function place(
  tenant: TenantDoc,
  p: Placement,
): Promise<{ appointment: AppointmentDoc; payment?: PaymentDoc }> {
  const t = forTenant(tenant._id);
  // Expired holds are cancelled first, so the slot they took is free again for this booking.
  await sweepHolds(tenant);
  const { items, durationMin, subtotalMinor, item } = snapshot(p.request);
  if (durationMin > MAX_DURATION_MIN) {
    throw new AppError(422, "TOO_LONG", "Longer than a workday");
  }
  const online = p.source === "online";
  const windowDays = online ? p.branch.booking.windowDays : STAFF_WINDOW_DAYS;
  if (!insideWindow(p.branch, p.startAt, p.now, windowDays)) throw slotTaken();
  const earliest = online
    ? p.now + p.branch.booking.minNoticeMin * 60_000
    : p.now;
  const endAt = new Date(p.startAt.getTime() + durationMin * 60_000);

  const booked = await transaction(async (session) => {
    const barber = await lockBarber(
      t,
      { _id: p.barberId, branchId: p.branch._id },
      session,
    );
    if (!barber || !canServe(barber, p.request)) {
      throw new AppError(
        409,
        "BARBER_UNAVAILABLE",
        "This barber can't take this booking",
      );
    }
    const branch = await t.branches.findOne(
      { _id: p.branch._id, active: true },
      { session },
    );
    if (!branch) throw notFound();
    await assertFree(
      t,
      branch,
      barber,
      p.startAt,
      durationMin,
      earliest,
      session,
    );

    const price = await priceFor(t, {
      branchId: branch._id,
      item,
      subtotalMinor,
      customerId: p.customer._id,
      code: p.code,
      now: new Date(p.now),
      session,
    });
    if (p.code && !price.promotion) {
      throw new AppError(
        409,
        "PROMOTION_UNAVAILABLE",
        "That code doesn't apply",
        [{ path: "code", message: price.rejected ?? "unknown_code" }],
      );
    }
    if (price.promotion) await redeem(t, price.promotion, session);

    const now = new Date();
    const appointment: AppointmentDoc = {
      _id: new ObjectId(),
      tenantId: tenant._id,
      branchId: branch._id,
      barberId: barber._id,
      customerId: p.customer._id,
      status: "confirmed",
      startAt: p.startAt,
      endAt,
      blockedUntil: new Date(
        endAt.getTime() + branch.booking.bufferMin * 60_000,
      ),
      timeZone: branch.timeZone,
      items,
      currency: tenant.currency,
      subtotalMinor: price.subtotalMinor,
      discountMinor: price.discountMinor,
      totalMinor: price.totalMinor,
      promotion: price.promotionSnapshot,
      notes: p.notes,
      source: p.source,
      createdBy: p.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    const payment = await planPayment(tenant, appointment, {
      online: p.online === true,
      hold: p.hold,
      now,
      session,
    });
    if (payment && p.hold) {
      // Held, not confirmed: the barber hears about it once it is paid (`payments/holds.ts`).
      appointment.status = "pending_payment";
      appointment.paymentDeadline = p.hold.deadline;
      appointment.payment = summaryOf(payment);
    }
    await t.appointments.insertOne(appointment, { session }).catch((err) => {
      throw isDuplicate(err) ? slotTaken() : err;
    });
    if (payment) {
      const { tenantId: _, ...doc } = payment;
      await t.payments.insertOne(doc, { session });
      return { appointment, payment, notes: [] };
    }
    const note = await notifyBarber(
      t,
      {
        type: "appointment.booked",
        appointment,
        barber,
        branch,
        customerName: p.customer.name,
        by: p.createdBy,
      },
      session,
    );
    return { appointment, payment: undefined, notes: [note] };
  });
  pushAfterCommit(tenant, booked.notes);
  return { appointment: booked.appointment, payment: booked.payment };
}

export async function bookOnline(
  tenant: TenantDoc,
  auth: Auth | undefined,
  input: z.output<typeof publicBooking>,
  ip: string,
) {
  const t = forTenant(tenant._id);
  if (!(await hit(`book:${tenant._id}:${ip}`, 20, HOUR_MS))) throw tooMany();
  const [branch, request] = await Promise.all([
    t.branches.findOne({ slug: input.branch, active: true }),
    resolveRequest(tenant._id, input),
  ]);
  if (!branch) throw notFound();
  const barber = await t.barbers.findOne({
    slug: input.barber,
    branchId: branch._id,
    active: true,
  });
  if (!barber) throw notFound();

  const signedIn = auth?.role === "customer" ? await getUser(auth) : undefined;
  if (!signedIn && !input.customer) {
    throw new AppError(422, "VALIDATION", "Invalid request", [
      { path: "customer", message: "name and phone are required" },
    ]);
  }
  const who = signedIn ? String(signedIn._id) : (input.customer?.phone ?? "");
  if (!(await hit(`book:${tenant._id}:${who}`, 5, HOUR_MS))) throw tooMany();
  const customer = signedIn
    ? await customerForUser(t, signedIn)
    : await customerForGuest(t, input.customer ?? { name: "", phone: "" });

  const now = Date.now();
  const hold =
    input.payment && holdFor(tenant, input.payment, input.startAt, now);
  const { appointment, payment } = await place(tenant, {
    branch,
    barberId: barber._id,
    request,
    startAt: input.startAt,
    customer,
    code: input.code,
    notes: input.notes,
    source: "online",
    now,
    online: onlinePaymentsReady(tenant),
    hold,
  });
  const checkout =
    payment && (await startCharge(tenant, appointment, payment, customer));
  const booked = checkout
    ? { ...appointment, status: checkout.appointmentStatus }
    : appointment;
  return {
    ...customerView(booked, branch, barber, Date.now()),
    ...(checkout && { checkout }),
  };
}

/** The customer's choice to pay online, checked before anything is held. */
function holdFor(
  tenant: TenantDoc,
  choice: NonNullable<z.output<typeof publicBooking>["payment"]>,
  startAt: Date,
  now: number,
): HoldRequest {
  const accountId = tenant.stripeConnect?.accountId;
  if (!onlinePaymentsReady(tenant) || !accountId) {
    throw new AppError(
      409,
      "ONLINE_PAYMENT_UNAVAILABLE",
      "This barbershop doesn't take online payments",
    );
  }
  // Mexican bank transfers only take pesos: a shop charging in dollars takes cards only.
  onlineCurrencyFor(tenant.currency, choice.method);
  const deadline = holdEnds(choice.method, now, holdMinutes());
  if (choice.method === "bank_transfer" && !transferFits(startAt, deadline)) {
    throw new AppError(
      409,
      "TRANSFER_TOO_LATE",
      "A transfer can't arrive before this appointment",
    );
  }
  return { ...choice, deadline, accountId };
}

export async function bookAsStaff(
  tenant: TenantDoc,
  auth: Auth,
  input: z.output<typeof staffBooking>,
) {
  const t = forTenant(tenant._id);
  const [branch, own, request, customer] = await Promise.all([
    getBranch(auth, input.branchId),
    auth.role === "barber" ? ownBarberId(auth) : undefined,
    resolveRequest(tenant._id, input),
    input.customerId
      ? t.customers.findOne({ _id: input.customerId })
      : input.customer && customerForGuest(t, input.customer),
  ]);
  if (auth.role === "barber" && !own?.equals(input.barberId)) throw forbidden();
  if (!customer) {
    throw new AppError(422, "VALIDATION", "Invalid request", [
      { path: "customerId", message: "unknown customer" },
    ]);
  }
  const { appointment } = await place(tenant, {
    branch,
    barberId: input.barberId,
    request,
    startAt: input.startAt,
    customer,
    code: input.code,
    notes: input.notes,
    source: "staff",
    createdBy: auth.userId,
    now: Date.now(),
  });
  return getAppointment(auth, appointment._id);
}

export async function quote(
  tenant: TenantDoc,
  auth: Auth | undefined,
  input: z.output<typeof publicQuote>,
  ip: string,
) {
  if (!(await hit(`quote:${tenant._id}:${ip}`, 30, 10 * 60 * 1000)))
    throw tooMany();
  const t = forTenant(tenant._id);
  const [branch, request, customer] = await Promise.all([
    t.branches.findOne({ slug: input.branch, active: true }),
    resolveRequest(tenant._id, input),
    findCustomer(
      t,
      auth?.role === "customer"
        ? { userId: auth.userId }
        : { phone: input.phone },
    ),
  ]);
  if (!branch) throw notFound();
  const { durationMin, subtotalMinor, item } = snapshot(request);
  const price = await priceFor(t, {
    branchId: branch._id,
    item,
    subtotalMinor,
    customerId: customer?._id,
    code: input.code,
    now: new Date(),
  });
  return {
    currency: tenant.currency,
    durationMin,
    subtotalMinor: price.subtotalMinor,
    discountMinor: price.discountMinor,
    totalMinor: price.totalMinor,
    ...(price.promotionSnapshot && {
      promotion: {
        code: price.promotionSnapshot.code,
        name: price.promotionSnapshot.name,
        amountMinor: price.promotionSnapshot.amountMinor,
      },
    }),
    ...(price.rejected && { rejected: price.rejected }),
    // How much paying online would charge and refund, computed here so the screen never guesses.
    ...(onlinePaymentsReady(tenant) && {
      online: onlineOptions(tenant, price.totalMinor),
    }),
  };
}

async function cancel(
  tenant: TenantDoc,
  appointment: AppointmentDoc,
  by: ObjectId,
  reason: string | undefined,
  who: "customer" | "staff",
) {
  const t = forTenant(tenant._id);
  let cancelNoticeMin = 0;
  const notes = await transaction(async (session) => {
    const now = new Date();
    const result = await t.appointments.updateOne(
      { _id: appointment._id, status: "confirmed" },
      {
        $set: {
          status: "cancelled",
          cancelledAt: now,
          cancelledBy: by,
          cancelReason: reason,
          updatedAt: now,
        },
      },
      { session },
    );
    if (result.modifiedCount === 0) throw notConfirmed();
    if (appointment.promotion) {
      await release(t, appointment.promotion.promotionId, session);
    }
    const barber = await t.barbers.findOne(
      { _id: appointment.barberId },
      { session },
    );
    const branch = await t.branches.findOne(
      { _id: appointment.branchId },
      { session },
    );
    cancelNoticeMin = branch?.booking.cancelNoticeMin ?? 0;
    const customer = await t.customers.findOne(
      { _id: appointment.customerId },
      { session },
    );
    if (!barber || !branch) return [];
    return [
      await notifyBarber(
        t,
        {
          type: "appointment.cancelled",
          appointment,
          barber,
          branch,
          customerName: customer?.name ?? "",
          by,
        },
        session,
      ),
    ];
  });
  pushAfterCommit(tenant, notes);
  await refundAfterCancel(tenant, appointment, who, cancelNoticeMin);
}

export async function listMine(tenant: TenantDoc, auth: Auth) {
  const t = forTenant(tenant._id);
  await sweepHolds(tenant);
  const customer = await findCustomer(t, { userId: auth.userId });
  if (!customer) return [];
  const list = await collect(
    t.appointments
      .find({ customerId: customer._id })
      .sort({ startAt: -1 })
      .limit(50),
  );
  const { branchOf, barberOf } = await lookups(t, list);
  const now = Date.now();
  return list.map((a) =>
    customerView(a, branchOf(a.branchId), barberOf(a.barberId), now),
  );
}

export async function cancelMine(tenant: TenantDoc, auth: Auth, id: ObjectId) {
  const t = forTenant(tenant._id);
  const customer = await findCustomer(t, { userId: auth.userId });
  const appointment =
    customer &&
    (await t.appointments.findOne({ _id: id, customerId: customer._id }));
  if (!appointment) throw notFound();
  // Not paid yet: giving it up frees the slot at once, whatever the notice.
  if (appointment.status === "pending_payment") {
    return cancelHold(tenant, appointment._id);
  }
  if (appointment.status !== "confirmed") throw notConfirmed();
  const branch = await t.branches.findOne({ _id: appointment.branchId });
  const notice = (branch?.booking.cancelNoticeMin ?? 0) * 60_000;
  if (Date.now() > appointment.startAt.getTime() - notice) {
    throw new AppError(
      409,
      "TOO_LATE",
      "Too close to the appointment to cancel online",
    );
  }
  await cancel(tenant, appointment, auth.userId, undefined, "customer");
}

async function ownAppointment(tenant: TenantDoc, auth: Auth, id: ObjectId) {
  const t = forTenant(tenant._id);
  const customer = await findCustomer(t, { userId: auth.userId });
  const appointment =
    customer &&
    (await t.appointments.findOne({ _id: id, customerId: customer._id }));
  if (!appointment) throw notFound();
  if (appointment.status !== "confirmed") throw notConfirmed();
  return appointment;
}

function tooLate() {
  return new AppError(
    409,
    "TOO_LATE",
    "Too close to the appointment to change online",
  );
}

export async function rescheduleSlots(
  tenant: TenantDoc,
  auth: Auth,
  id: ObjectId,
  range: { from?: string; days?: number },
  now = Date.now(),
) {
  const t = forTenant(tenant._id);
  const appointment = await ownAppointment(tenant, auth, id);
  const [branch, barber] = await Promise.all([
    t.branches.findOne({ _id: appointment.branchId, active: true }),
    t.barbers.findOne({ _id: appointment.barberId, active: true }),
  ]);
  if (!branch || !barber) throw notFound();
  const needs = bookedServiceIds(appointment.items);
  if (
    !needs.every((serviceId) =>
      barber.serviceIds.some((offered) => offered.equals(serviceId)),
    )
  ) {
    throw new AppError(
      409,
      "BARBER_UNAVAILABLE",
      "This barber can't take this booking",
    );
  }
  const minutes = bookedMinutes(appointment.items);
  const { today, dates } = bookableDates(
    branch.timeZone,
    now,
    branch.booking.windowDays,
    range,
  );
  const span = spanOf(dates, branch.timeZone);
  const schedule = span
    ? await scheduleOf(t, branch, [barber._id], span, {
        except: appointment._id,
      })
    : () => ({ blocks: [], busy: [] });
  const input = engineInput(
    branch,
    barber,
    minutes,
    now + branch.booking.minNoticeMin * 60_000,
    schedule(barber._id),
  );
  return {
    branch: {
      slug: branch.slug,
      name: branch.name,
      timeZone: branch.timeZone,
    },
    today,
    dates,
    durationMin: minutes,
    barbers: [
      {
        slug: barber.slug,
        name: barber.name,
        ...(photos(barber).image && { image: photos(barber).image }),
        days: freeSlots(input, dates).map((day) => ({
          date: day.date,
          slots: day.slots.map((slot) => ({
            startAt: slot.startAt.toISOString(),
            time: slot.time,
          })),
        })),
      },
    ],
  };
}

export async function rescheduleMine(
  tenant: TenantDoc,
  auth: Auth,
  id: ObjectId,
  startAt: Date,
) {
  const t = forTenant(tenant._id);
  const appointment = await ownAppointment(tenant, auth, id);
  const branch = await t.branches.findOne({
    _id: appointment.branchId,
    active: true,
  });
  if (!branch) throw notFound();
  const now = Date.now();
  const notice = branch.booking.cancelNoticeMin * 60_000;
  if (now > appointment.startAt.getTime() - notice) throw tooLate();
  if (!insideWindow(branch, startAt, now, branch.booking.windowDays)) {
    throw slotTaken();
  }
  if (startAt.getTime() < now + branch.booking.minNoticeMin * 60_000) {
    throw slotTaken();
  }
  await reschedule(tenant, auth, appointment, { startAt });
  const moved =
    (await t.appointments.findOne({ _id: appointment._id })) ?? appointment;
  const [freshBranch, barber] = await Promise.all([
    t.branches.findOne({ _id: moved.branchId }),
    t.barbers.findOne({ _id: moved.barberId }),
  ]);
  return customerView(
    moved,
    freshBranch ?? undefined,
    barber ?? undefined,
    now,
  );
}

async function visibleTo(auth: Auth): Promise<Filter<AppointmentDoc>[]> {
  const clauses: Filter<AppointmentDoc>[] = [];
  const ids = visibleBranchIds(auth);
  if (ids) clauses.push({ branchId: { $in: ids } });
  if (auth.role === "barber") {
    const own = await ownBarberId(auth);
    clauses.push({ barberId: { $in: own ? [own] : [] } });
  }
  return clauses;
}

export async function listAppointments(
  auth: Auth,
  range: z.output<typeof appointmentRange>,
) {
  const t = forTenant(auth.tenantId);
  const from = range.from ?? new Date(Date.now() - 12 * HOUR_MS);
  const to = range.to ?? new Date(from.getTime() + 7 * 24 * HOUR_MS);
  const clauses = [
    ...(await visibleTo(auth)),
    { startAt: { $gte: from, $lt: to } },
    ...(range.branchId ? [{ branchId: range.branchId }] : []),
    ...(range.barberId ? [{ barberId: range.barberId }] : []),
  ];
  const list = await collect(
    t.appointments.find({ $and: clauses }).sort({ startAt: 1 }).limit(1000),
  );
  return staffViews(t, list);
}

async function findVisible(auth: Auth, id: ObjectId) {
  const appointment = await forTenant(auth.tenantId).appointments.findOne({
    $and: [{ _id: id }, ...(await visibleTo(auth))],
  });
  if (!appointment) throw notFound();
  return appointment;
}

export async function getAppointment(auth: Auth, id: ObjectId) {
  const [view] = await staffViews(forTenant(auth.tenantId), [
    await findVisible(auth, id),
  ]);
  if (!view) throw notFound();
  return view;
}

async function reschedule(
  tenant: TenantDoc,
  auth: Auth,
  appointment: AppointmentDoc,
  change: { startAt?: Date; barberId?: ObjectId },
) {
  const t = forTenant(tenant._id);
  await sweepHolds(tenant);
  const barberId = change.barberId ?? appointment.barberId;
  const startAt = change.startAt ?? appointment.startAt;
  if (auth.role === "barber" && !barberId.equals(appointment.barberId)) {
    throw forbidden();
  }
  const minutes = bookedMinutes(appointment.items);
  const needs = bookedServiceIds(appointment.items);
  const now = Date.now();
  const notes = await transaction(async (session) => {
    const barber = await lockBarber(
      t,
      { _id: barberId, branchId: appointment.branchId },
      session,
    );
    if (
      !barber ||
      !needs.every((id) => barber.serviceIds.some((x) => x.equals(id)))
    ) {
      throw new AppError(
        409,
        "BARBER_UNAVAILABLE",
        "This barber can't take this booking",
      );
    }
    const branch = await t.branches.findOne(
      { _id: appointment.branchId },
      { session },
    );
    if (!branch || !insideWindow(branch, startAt, now, STAFF_WINDOW_DAYS)) {
      throw slotTaken();
    }
    await assertFree(
      t,
      branch,
      barber,
      startAt,
      minutes,
      now,
      session,
      appointment._id,
    );
    const endAt = new Date(startAt.getTime() + minutes * 60_000);
    const moved = await t.appointments
      .findOneAndUpdate(
        { _id: appointment._id, status: "confirmed" },
        {
          $set: {
            barberId: barber._id,
            startAt,
            endAt,
            blockedUntil: new Date(
              endAt.getTime() + branch.booking.bufferMin * 60_000,
            ),
            updatedAt: new Date(),
          },
        },
        { session, returnDocument: "after" },
      )
      .catch((err) => {
        throw isDuplicate(err) ? slotTaken() : err;
      });
    if (!moved) throw notConfirmed();

    const customer = await t.customers.findOne(
      { _id: moved.customerId },
      { session },
    );
    const customerName = customer?.name ?? "";
    const toNew = await notifyBarber(
      t,
      {
        type: "appointment.rescheduled",
        appointment: moved,
        barber,
        branch,
        customerName,
        by: auth.userId,
      },
      session,
    );
    if (barber._id.equals(appointment.barberId)) return [toNew];
    const previous = await t.barbers.findOne(
      { _id: appointment.barberId },
      { session },
    );
    const toPrevious =
      previous &&
      (await notifyBarber(
        t,
        {
          type: "appointment.cancelled",
          appointment,
          barber: previous,
          branch,
          customerName,
          by: auth.userId,
        },
        session,
      ));
    return [toNew, toPrevious ?? undefined];
  });
  pushAfterCommit(tenant, notes);
}

export async function updateAppointment(
  tenant: TenantDoc,
  auth: Auth,
  id: ObjectId,
  input: z.output<typeof appointmentUpdate>,
) {
  const t = forTenant(tenant._id);
  const appointment = await findVisible(auth, id);
  const changesState = input.status || input.startAt || input.barberId;
  if (changesState && appointment.status !== "confirmed") throw notConfirmed();

  if (input.status === "cancelled") {
    await cancel(tenant, appointment, auth.userId, input.cancelReason, "staff");
  } else if (input.status) {
    if (appointment.startAt.getTime() > Date.now()) {
      throw new AppError(409, "NOT_STARTED", "It hasn't started yet");
    }
    // Completing freezes the barber's commission, so a later rate change can't rewrite what was earned.
    const barber =
      input.status === "completed"
        ? await t.barbers.findOne({ _id: appointment.barberId })
        : null;
    const commission = resolveCommission(
      { ...appointment, status: input.status },
      barber?.commissionBps,
    );
    const result = await t.appointments.updateOne(
      { _id: id, status: "confirmed" },
      {
        $set: {
          status: input.status,
          ...(commission && {
            commission: {
              bps: commission.bps,
              amountMinor: commission.amountMinor,
            },
          }),
          updatedAt: new Date(),
        },
      },
    );
    if (result.modifiedCount === 0) throw notConfirmed();
  } else if (input.startAt || input.barberId) {
    await reschedule(tenant, auth, appointment, input);
  }
  if (input.notes) {
    await t.appointments.updateOne(
      { _id: id },
      { $set: { notes: input.notes, updatedAt: new Date() } },
    );
  }
  return getAppointment(auth, id);
}
