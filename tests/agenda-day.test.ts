import { expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { appointments } from "../src/db/collections";
import { addBranch, api, createShop, instantIn } from "./helpers";

test("a day of the agenda is each branch's own local day, whatever the server's zone", async () => {
  const { tenant, host, owner, branchId, asOwner } = await createShop();
  const cdmx = await addBranch(host, owner.token, {
    timeZone: "America/Mexico_City",
  });
  const seed = async (branch: string, timeZone: string, local: string) => {
    const [date = "", time = ""] = local.split("T");
    const startAt = new Date(instantIn(timeZone, date, time));
    const endAt = new Date(startAt.getTime() + 45 * 60_000);
    const _id = new ObjectId();
    await appointments.insertOne({
      _id,
      tenantId: tenant._id,
      branchId: new ObjectId(branch),
      barberId: new ObjectId(),
      customerId: new ObjectId(),
      status: "confirmed",
      startAt,
      endAt,
      blockedUntil: endAt,
      timeZone,
      items: [
        {
          kind: "service",
          serviceId: new ObjectId(),
          name: { es: "Corte" },
          durationMin: 45,
          priceMinor: 30_000,
        },
      ],
      currency: "MXN",
      subtotalMinor: 30_000,
      discountMinor: 0,
      totalMinor: 30_000,
      source: "staff",
      createdAt: startAt,
      updatedAt: startAt,
    });
    return _id.toHexString();
  };
  const lateTijuana = await seed(
    branchId,
    "America/Tijuana",
    "2026-11-10T23:30",
  );
  const earlyCdmx = await seed(cdmx, "America/Mexico_City", "2026-11-10T00:30");
  await seed(branchId, "America/Tijuana", "2026-11-11T00:15");

  const ids = async (date: string) =>
    (
      (await api("GET", `/v1/appointments?date=${date}`, asOwner))
        .body as unknown as { id: string }[]
    ).map((a) => a.id);
  expect((await ids("2026-11-10")).sort()).toEqual(
    [lateTijuana, earlyCdmx].sort(),
  );
  expect(await ids("2026-11-11")).toHaveLength(1);
  expect(
    (
      await api(
        "GET",
        "/v1/appointments?date=2026-11-10&from=2026-11-10T00:00:00Z",
        asOwner,
      )
    ).status,
  ).toBe(422);
});
