import { describe, expect, test } from "bun:test";
import { waitlist } from "../src/db/collections";
import { notifyWaitlist } from "../src/features/waitlist/notify";
import { outbox } from "../src/shared/mail";
import { api, bookingShop, createUser, dayIn, type Shop } from "./helpers";

const close = async (shop: Shop, from: number, to: number) => {
  const res = await api("POST", "/v1/time-off", {
    ...shop.asOwner,
    body: {
      branchId: shop.branchId,
      kind: "closure",
      start: `${dayIn(shop.timeZone, from)}T00:00`,
      end: `${dayIn(shop.timeZone, to)}T00:00`,
    },
  });
  expect(res.status).toBe(201);
  return String(res.body.id);
};
const customerOf = async (shop: Shop) => {
  const { user, token } = await createUser(shop.tenant, "customer");
  return { user, who: { host: shop.host, token } };
};
const join = (
  shop: Shop,
  who: { host: string; token: string },
  days: number,
  extra: Record<string, unknown> = {},
) =>
  api("POST", "/v1/me/waitlist", {
    ...who,
    body: {
      branch: "centro",
      service: "corte",
      date: dayIn(shop.timeZone, days),
      ...extra,
    },
  });
const mailsTo = (address: string | undefined) =>
  outbox.filter((m) => m.to === address);

describe("waiting list", () => {
  test("tells a waiting customer once when their day opens up, and not before", async () => {
    const shop = await bookingShop();
    const closure = await close(shop, 3, 4);
    const { user, who } = await customerOf(shop);

    expect((await join(shop, who, 3)).status).toBe(201);
    expect((await join(shop, who, 3)).body.error?.code).toBe("ALREADY_WAITING");
    await notifyWaitlist(shop.tenant);
    expect(mailsTo(user.email)).toHaveLength(0);

    await api("DELETE", `/v1/time-off/${closure}`, shop.asOwner);
    await notifyWaitlist(shop.tenant);
    await notifyWaitlist(shop.tenant);
    const mails = mailsTo(user.email);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.subject).toContain(shop.tenant.name);
    expect(mails[0]?.text).toContain("/es/services/corte?branch=centro");

    const mine = await api("GET", "/v1/me/waitlist", who);
    expect(mine.body).toMatchObject([
      {
        item: { kind: "service", slug: "corte" },
        branch: { slug: "centro" },
        status: "notified",
      },
    ]);
  });

  test("only customers, only full days, only days that can be booked, at most five", async () => {
    const shop = await bookingShop();
    const { who } = await customerOf(shop);

    expect(
      (await api("POST", "/v1/me/waitlist", { host: shop.host, body: {} }))
        .status,
    ).toBe(401);
    expect((await join(shop, who, 3)).body.error?.code).toBe("SLOTS_AVAILABLE");

    await close(shop, 2, 12);
    expect((await join(shop, who, 40)).status).toBe(422);
    expect((await join(shop, who, -1)).status).toBe(422);
    for (const day of [2, 3, 4, 5, 6]) {
      expect((await join(shop, who, day)).status).toBe(201);
    }
    expect((await join(shop, who, 7)).body.error?.code).toBe("WAITLIST_FULL");
  });

  test("a time window that nothing fits in is never told, and a customer who booked is dropped", async () => {
    const shop = await bookingShop();
    const closure = await close(shop, 3, 4);
    const early = await customerOf(shop);
    const booked = await customerOf(shop);
    await join(shop, early.who, 3, { from: "07:00", to: "08:00" });
    await join(shop, booked.who, 3);

    await api("DELETE", `/v1/time-off/${closure}`, shop.asOwner);
    // The second customer books that day on their own before the next run.
    const slot = await api(
      "GET",
      `/v1/public/availability?branch=centro&service=corte&barber=mateo&from=${dayIn(shop.timeZone, 3)}&days=1`,
      { host: shop.host },
    );
    const [barber] = slot.body.barbers as {
      days: { slots: { startAt: string }[] }[];
    }[];
    const startAt = barber?.days[0]?.slots[0]?.startAt;
    await api("POST", "/v1/public/appointments", {
      ...booked.who,
      body: { branch: "centro", barber: "mateo", service: "corte", startAt },
    });

    await notifyWaitlist(shop.tenant);
    expect(mailsTo(early.user.email)).toHaveLength(0);
    expect(
      mailsTo(booked.user.email).some((m) => m.subject.includes("horario")),
    ).toBe(false);
    expect(await waitlist.countDocuments({ customerId: booked.user._id })).toBe(
      0,
    );
    expect(await waitlist.countDocuments({ customerId: early.user._id })).toBe(
      1,
    );
  });

  test("tells the first three in line per day and leaves the rest for a later run", async () => {
    const shop = await bookingShop();
    const closure = await close(shop, 3, 4);
    const people = [];
    for (let i = 0; i < 4; i++) {
      const person = await customerOf(shop);
      await join(shop, person.who, 3);
      people.push(person);
    }
    await api("DELETE", `/v1/time-off/${closure}`, shop.asOwner);
    await notifyWaitlist(shop.tenant);
    expect(people.map((p) => mailsTo(p.user.email).length)).toEqual([
      1, 1, 1, 0,
    ]);
    await notifyWaitlist(shop.tenant);
    expect(people.map((p) => mailsTo(p.user.email).length)).toEqual([
      1, 1, 1, 1,
    ]);
  });

  test("a customer sees and leaves only their own entries", async () => {
    const shop = await bookingShop();
    await close(shop, 3, 4);
    const mine = await customerOf(shop);
    const other = await customerOf(shop);
    const entry = await join(shop, mine.who, 3);

    expect(
      Object.values((await api("GET", "/v1/me/waitlist", other.who)).body),
    ).toEqual([]);
    expect(
      (await api("DELETE", `/v1/me/waitlist/${entry.body.id}`, other.who))
        .status,
    ).toBe(404);
    expect(
      (await api("DELETE", `/v1/me/waitlist/${entry.body.id}`, mine.who))
        .status,
    ).toBe(204);
    expect(
      Object.values((await api("GET", "/v1/me/waitlist", mine.who)).body),
    ).toEqual([]);
  });
});
