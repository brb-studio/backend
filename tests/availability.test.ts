import { describe, expect, test } from "bun:test";
import {
  api,
  bookingShop,
  create,
  dayIn,
  guestBooking,
  instantIn,
} from "./helpers";

type Slot = { startAt: string; time: string };
type Barber = { slug: string; days: { date: string; slots: Slot[] }[] };
type Availability = {
  today: string;
  dates: string[];
  durationMin: number;
  barbers: Barber[];
};

async function availability(host: string, query: string) {
  const res = await api(
    "GET",
    `/v1/public/availability?branch=centro&${query}`,
    { host },
  );
  return { status: res.status, body: res.body as unknown as Availability };
}
const timesOn = (a: Availability, barber: string, date: string) =>
  a.barbers
    .find((b) => b.slug === barber)
    ?.days.find((d) => d.date === date)
    ?.slots.map((s) => s.time) ?? [];

describe("public availability", () => {
  test("covers the booking window, fits each barber's hours and the service's length", async () => {
    const shop = await bookingShop();
    const tomorrow = dayIn(shop.timeZone, 1);
    const { status, body } = await availability(shop.host, "service=masaje");
    expect(status).toBe(200);
    expect(body.today).toBe(dayIn(shop.timeZone, 0));
    expect(body.dates).toHaveLength(14);
    expect(body.barbers.map((b) => b.slug)).toEqual(["lucas"]);
    const times = timesOn(body, "lucas", tomorrow);
    expect(times[0]).toBe("10:00");
    expect(times.at(-1)).toBe("17:30");
    expect(times).toContain("10:15");

    const pkg = await availability(shop.host, "package=corte-barba");
    expect(pkg.body.durationMin).toBe(75);
    expect(timesOn(pkg.body, "mateo", tomorrow).at(-1)).toBe("16:45");
  });

  test("today starts after the minimum notice", async () => {
    const shop = await bookingShop();
    const { body } = await availability(shop.host, "service=corte");
    const earliest = Date.now() + 60 * 60_000 - 5_000;
    for (const barber of body.barbers) {
      for (const slot of barber.days.find((d) => d.date === body.today)
        ?.slots ?? []) {
        expect(Date.parse(slot.startAt)).toBeGreaterThanOrEqual(earliest);
      }
    }
  });

  test("an appointment, a barber's time off and a branch closure all take time away", async () => {
    const shop = await bookingShop();
    const day = dayIn(shop.timeZone, 2);
    const at = (time: string) => instantIn(shop.timeZone, day, time);
    expect(
      (
        await api("POST", "/v1/public/appointments", {
          host: shop.host,
          body: guestBooking(at("12:00")),
        })
      ).status,
    ).toBe(201);

    let { body } = await availability(shop.host, "service=corte");
    const mateo = timesOn(body, "mateo", day);
    expect(mateo).toContain("11:15");
    for (const t of ["11:30", "12:00", "12:30"]) expect(mateo).not.toContain(t);
    expect(mateo).toContain("12:45");
    expect(timesOn(body, "lucas", day)).toContain("12:00");

    await create(shop.asOwner, "/v1/time-off", {
      barberId: shop.barbers.lucas,
      kind: "break",
      start: `${day}T14:00`,
      end: `${day}T15:00`,
    });
    ({ body } = await availability(shop.host, "service=corte"));
    expect(timesOn(body, "lucas", day)).not.toContain("14:30");
    expect(timesOn(body, "mateo", day)).toContain("14:30");

    const closed = dayIn(shop.timeZone, 3);
    await create(shop.asOwner, "/v1/time-off", {
      branchId: shop.branchId,
      kind: "closure",
      start: `${closed}T00:00`,
      end: `${dayIn(shop.timeZone, 4)}T00:00`,
    });
    ({ body } = await availability(shop.host, "service=corte"));
    for (const barber of body.barbers) {
      expect(barber.days.some((d) => d.date === closed)).toBe(false);
    }
  });

  test("slots are instants in the branch's own timezone", async () => {
    const shop = await bookingShop({ timeZone: "America/New_York" });
    const tomorrow = dayIn(shop.timeZone, 1);
    const { body } = await availability(
      shop.host,
      "service=corte&barber=mateo",
    );
    const first = body.barbers[0]?.days.find((d) => d.date === tomorrow)
      ?.slots[0];
    expect(first).toEqual({
      time: "10:00",
      startAt: new Date(
        instantIn(shop.timeZone, tomorrow, "10:00"),
      ).toISOString(),
    });
  });

  test("errors: unknown branch or barber, a barber who can't, both service and package", async () => {
    const shop = await bookingShop();
    expect(
      (
        await api("GET", "/v1/public/availability?branch=nope&service=corte", {
          host: shop.host,
        })
      ).status,
    ).toBe(404);
    expect(
      (await availability(shop.host, "service=corte&barber=nadie")).status,
    ).toBe(404);
    expect(
      (await availability(shop.host, "service=masaje&barber=mateo")).status,
    ).toBe(404);
    expect(
      (await availability(shop.host, "service=corte&package=corte-barba"))
        .status,
    ).toBe(422);
    expect(
      (await availability(shop.host, "service=corte&days=40")).status,
    ).toBe(422);
  });
});

describe("staff availability", () => {
  test("ignores the minimum notice and lets a barber see only themselves", async () => {
    const shop = await bookingShop({ booking: { minNoticeMin: 600 } });
    const query = `branchId=${shop.branchId}&serviceId=${shop.services.corte}`;
    const res = await api("GET", `/v1/availability?${query}`, shop.asOwner);
    expect(res.status).toBe(200);
    const body = res.body as unknown as Availability;
    expect(body.barbers.map((b) => b.slug).sort()).toEqual(["lucas", "mateo"]);
  });
});
