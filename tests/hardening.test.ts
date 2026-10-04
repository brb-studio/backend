import { describe, expect, test } from "bun:test";
import type { Document } from "mongodb";
import { app } from "../src/app";
import { appointments, timeOff } from "../src/db/collections";
import {
  api,
  bookingShop,
  create,
  createUser,
  dayIn,
  guestBooking,
  instantIn,
} from "./helpers";

describe("tenant isolation sweep", () => {
  test("every id route answers 404 to another tenant and changes nothing", async () => {
    const a = await bookingShop();
    const b = await bookingShop();
    const day = dayIn(b.timeZone, 2);
    const appointment = await api("POST", "/v1/public/appointments", {
      host: b.host,
      body: guestBooking(instantIn(b.timeZone, day, "10:00")),
    });
    const entry = await create(b.asOwner, "/v1/time-off", {
      barberId: b.barbers.lucas,
      kind: "break",
      start: `${day}T15:00`,
      end: `${day}T16:00`,
    });
    const promo = await create(b.asOwner, "/v1/promotions", {
      name: { es: "B" },
      type: "fixed",
      value: 100,
    });
    const staff = await createUser(b.tenant, "manager", {
      branchId: b.tenant._id,
    });

    const routes: [string, string, unknown?][] = [
      ["GET", `/v1/branches/${b.branchId}`],
      ["PATCH", `/v1/branches/${b.branchId}`, { name: "x" }],
      ["GET", `/v1/barbers/${b.barbers.mateo}`],
      ["PATCH", `/v1/barbers/${b.barbers.mateo}`, { name: "x" }],
      ["GET", `/v1/services/${b.services.corte}`],
      ["PATCH", `/v1/services/${b.services.corte}`, { priceMinor: 1 }],
      ["GET", `/v1/packages/${b.pkg}`],
      ["PATCH", `/v1/packages/${b.pkg}`, { priceMinor: 1 }],
      ["GET", `/v1/promotions/${promo}`],
      ["PATCH", `/v1/promotions/${promo}`, { value: 1 }],
      ["GET", `/v1/appointments/${appointment.body.id}`],
      [
        "PATCH",
        `/v1/appointments/${appointment.body.id}`,
        { status: "cancelled" },
      ],
      ["PATCH", `/v1/users/${staff.user._id}`, { name: "Intruso" }],
      ["DELETE", `/v1/time-off/${entry}`],
      [
        "GET",
        `/v1/availability?branchId=${b.branchId}&serviceId=${b.services.corte}`,
      ],
    ];
    for (const [method, path, body] of routes) {
      const res = await api(method, path, { ...a.asOwner, body });
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }
    expect(
      (await api("GET", `/v1/appointments/${appointment.body.id}`, b.asOwner))
        .body.status,
    ).toBe("confirmed");
    expect(await timeOff.countDocuments({ tenantId: b.tenant._id })).toBe(1);
  });
});

test("API responses carry security headers and are never cached", async () => {
  const res = await app.request("/health");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-request-id")).toBeTruthy();
});

describe("indexes", () => {
  const stages = (plan: Document): string[] => [
    String(plan.stage),
    ...(plan.inputStage ? stages(plan.inputStage) : []),
    ...((plan.inputStages as Document[] | undefined) ?? []).flatMap(stages),
  ];
  const winning = async (cursor: { explain: () => Promise<Document> }) => {
    const explained = await cursor.explain();
    const plan = explained.queryPlanner.winningPlan as Document;
    return {
      stages: stages(plan.queryPlan ?? plan),
      index: JSON.stringify(plan),
    };
  };

  test("the availability overlap query and the agenda use their indexes", async () => {
    const shop = await bookingShop();
    const now = new Date();
    const overlap = await winning(
      appointments.find({
        tenantId: shop.tenant._id,
        barberId: { $in: [shop.tenant._id] },
        status: "confirmed",
        startAt: { $gte: now, $lt: new Date(now.getTime() + 864e5) },
        blockedUntil: { $gt: now },
      }),
    );
    expect(overlap.stages).toContain("IXSCAN");
    expect(overlap.index).toContain("barber_start_confirmed_unique");

    const agenda = await winning(
      appointments.find({
        tenantId: shop.tenant._id,
        branchId: shop.tenant._id,
        startAt: { $gte: now },
      }),
    );
    expect(agenda.stages).toContain("IXSCAN");
    expect(agenda.stages).not.toContain("COLLSCAN");
  });
});
