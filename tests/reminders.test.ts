import { describe, expect, test } from "bun:test";
import { notifications } from "../src/db/collections";
import { sendReminders } from "../src/features/notifications/reminders";
import { outbox } from "../src/shared/mail";
import {
  api,
  bookingShop,
  createUser,
  dayIn,
  guestBooking,
  instantIn,
  type Shop,
} from "./helpers";

const H = 60 * 60 * 1000;
const startOf = (shop: Shop, days: number, time: string) =>
  instantIn(shop.timeZone, dayIn(shop.timeZone, days), time);
// Booking notices also go by email; these tests only count the reminders.
const sentTo = (address: string) =>
  outbox.filter(
    (m) =>
      (m.to === address && m.subject.includes("ecordatorio")) ||
      (m.to === address && m.subject.includes("Reminder")),
  );
const remindAt = (shop: Shop, start: string, hoursBefore: number) =>
  sendReminders(
    shop.tenant,
    new Date(new Date(start).getTime() - hoursBefore * H),
  );

describe("appointment reminders", () => {
  test("a guest with an email hears 24 h and 2 h before, once each, and never when it's off", async () => {
    const shop = await bookingShop();
    const start = startOf(shop, 3, "11:00");
    const address = `ana-${Date.now()}@example.com`;
    await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(start, {
        customer: { name: "Ana López", phone: "+526641230001", email: address },
      }),
    });

    await remindAt(shop, start, 30);
    expect(sentTo(address)).toHaveLength(0);

    await remindAt(shop, start, 23);
    await remindAt(shop, start, 22); // the next tick must not repeat it
    expect(sentTo(address)).toHaveLength(1);
    expect(sentTo(address)[0]?.subject).toContain(shop.tenant.name);
    expect(sentTo(address)[0]?.text).toContain("Mateo");

    await remindAt(shop, start, 1.5);
    await remindAt(shop, start, 1);
    expect(sentTo(address)).toHaveLength(2);

    // A guest has no account: nothing goes to the inbox.
    expect(
      await notifications.countDocuments({ tenantId: shop.tenant._id }),
    ).toBe(0);

    const off = await bookingShop({
      tenant: { reminders: { enabled: false } },
    });
    const offStart = startOf(off, 3, "11:00");
    const offAddress = `off-${Date.now()}@example.com`;
    await api("POST", "/v1/public/appointments", {
      host: off.host,
      body: guestBooking(offStart, {
        customer: { name: "Beto", phone: "+526641230002", email: offAddress },
      }),
    });
    await remindAt(off, offStart, 1.5);
    expect(sentTo(offAddress)).toHaveLength(0);
  });

  test("an account gets it in the inbox and by email; cancelled and rescheduled appointments behave", async () => {
    const shop = await bookingShop();
    const customer = await createUser(shop.tenant, "customer");
    const who = { host: shop.host, token: customer.token };
    const start = startOf(shop, 3, "11:00");
    const booked = await api("POST", "/v1/public/appointments", {
      ...who,
      body: guestBooking(start, { customer: undefined }),
    });

    await remindAt(shop, start, 23);
    const inbox = await notifications
      .find({ userId: customer.user._id, type: "customer.reminder" })
      .toArray();
    expect(inbox).toHaveLength(1);
    expect(sentTo(customer.user.email ?? "")).toHaveLength(1);

    // Moved to another time: the new time gets its own reminders.
    const moved = startOf(shop, 3, "15:00");
    await api("PATCH", `/v1/appointments/${booked.body.id}`, {
      ...shop.asOwner,
      body: { startAt: moved },
    });
    await remindAt(shop, moved, 23);
    expect(sentTo(customer.user.email ?? "")).toHaveLength(2);

    await api("PATCH", `/v1/appointments/${booked.body.id}`, {
      ...shop.asOwner,
      body: { status: "cancelled" },
    });
    await remindAt(shop, moved, 1.5);
    expect(sentTo(customer.user.email ?? "")).toHaveLength(2);
  });
});

test("the cron endpoints do not exist without their secret", async () => {
  for (const path of ["/cron/tick", "/cron/digest"]) {
    expect((await api("GET", path, { host: "x.localhost" })).status).toBe(404);
  }
});
