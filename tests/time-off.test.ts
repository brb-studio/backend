import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { barbers } from "../src/db/collections";
import {
  addBarber,
  addBranch,
  api,
  createShop,
  createUser,
  localDay,
} from "./helpers";

type Entry = { id: string; barberId?: string; kind: string };
const ids = (body: unknown) => (body as Entry[]).map((e) => e.id).sort();

describe("time off", () => {
  test("is entered in branch local time and stored as the right instants across DST", async () => {
    const { host, branchId, asOwner } = await createShop();
    const barberId = await addBarber(host, asOwner.token, branchId);
    const res = await api("POST", "/v1/time-off", {
      ...asOwner,
      body: {
        barberId,
        start: "2026-10-31T10:00",
        end: "2026-11-01T10:00",
        kind: "vacation",
        reason: "Viaje",
      },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      barberId,
      branchId,
      kind: "vacation",
      startAt: "2026-10-31T17:00:00.000Z",
      endAt: "2026-11-01T18:00:00.000Z",
      start: "2026-10-31T10:00",
      end: "2026-11-01T10:00",
      timeZone: "America/Tijuana",
    });
  });

  test("closures cover the whole branch; the shape must be one or the other", async () => {
    const { host, branchId, asOwner } = await createShop();
    const barberId = await addBarber(host, asOwner.token, branchId);
    const span = { start: localDay(30, "00:00"), end: localDay(31, "00:00") };

    const closure = await api("POST", "/v1/time-off", {
      ...asOwner,
      body: { branchId, kind: "closure", ...span },
    });
    expect(closure.status).toBe(201);
    expect(closure.body.barberId).toBeUndefined();

    for (const body of [
      { branchId, kind: "vacation", ...span },
      { barberId, kind: "closure", ...span },
      { barberId, branchId, kind: "block", ...span },
      { kind: "block", ...span },
      { barberId, kind: "block", start: span.end, end: span.start },
      {
        barberId,
        kind: "block",
        start: "2026-02-30T10:00",
        end: "2026-03-01T10:00",
      },
      { barberId, kind: "nap", ...span },
    ]) {
      expect(
        (await api("POST", "/v1/time-off", { ...asOwner, body })).status,
      ).toBe(422);
    }
  });

  test("a barber manages only their own time off", async () => {
    const { tenant, host, branchId, asOwner } = await createShop();
    const account = await createUser(tenant, "barber", {
      branchId: new ObjectId(branchId),
    });
    const unlinked = await createUser(tenant, "barber", {
      branchId: new ObjectId(branchId),
    });
    const own = await addBarber(host, asOwner.token, branchId, {
      userId: account.user._id.toHexString(),
    });
    const colleague = await addBarber(host, asOwner.token, branchId);
    const asBarber = { host, token: account.token };
    const span = { start: localDay(5, "14:00"), end: localDay(5, "15:00") };
    const post = (who: { host: string; token: string }, body: unknown) =>
      api("POST", "/v1/time-off", { ...who, body });

    const mine = await post(asBarber, {
      barberId: own,
      kind: "break",
      ...span,
    });
    expect(mine.status).toBe(201);
    expect(
      (await post(asBarber, { barberId: colleague, kind: "break", ...span }))
        .status,
    ).toBe(403);
    expect(
      (await post(asBarber, { branchId, kind: "closure", ...span })).status,
    ).toBe(403);
    expect(
      (
        await post(
          { host, token: unlinked.token },
          { barberId: own, kind: "break", ...span },
        )
      ).status,
    ).toBe(403);

    const theirs = await post(asOwner, {
      barberId: colleague,
      kind: "vacation",
      ...span,
    });
    const closure = await post(asOwner, { branchId, kind: "closure", ...span });
    expect(
      (await api("DELETE", `/v1/time-off/${theirs.body.id}`, asBarber)).status,
    ).toBe(403);
    expect(
      (await api("DELETE", `/v1/time-off/${closure.body.id}`, asBarber)).status,
    ).toBe(403);
    expect(
      (await api("DELETE", `/v1/time-off/${mine.body.id}`, asBarber)).status,
    ).toBe(204);
  });

  test("the list shows what hasn't ended, scoped by role", async () => {
    const { tenant, host, branchId, asOwner } = await createShop();
    const account = await createUser(tenant, "barber", {
      branchId: new ObjectId(branchId),
    });
    const manager = await createUser(tenant, "manager", {
      branchId: new ObjectId(branchId),
    });
    const a = await addBarber(host, asOwner.token, branchId, {
      userId: account.user._id.toHexString(),
    });
    const b = await addBarber(host, asOwner.token, branchId);
    const post = async (body: Record<string, unknown>) =>
      String((await api("POST", "/v1/time-off", { ...asOwner, body })).body.id);

    await post({
      barberId: a,
      kind: "block",
      start: localDay(-3, "10:00"),
      end: localDay(-2, "10:00"),
    });
    const upcomingA = await post({
      barberId: a,
      kind: "vacation",
      start: localDay(3, "10:00"),
      end: localDay(4, "10:00"),
    });
    const upcomingB = await post({
      barberId: b,
      kind: "vacation",
      start: localDay(3, "10:00"),
      end: localDay(4, "10:00"),
    });
    const closure = await post({
      branchId,
      kind: "closure",
      start: localDay(10, "00:00"),
      end: localDay(11, "00:00"),
    });
    const asManager = { host, token: manager.token };

    expect(ids((await api("GET", "/v1/time-off", asManager)).body)).toEqual(
      [upcomingA, upcomingB, closure].sort(),
    );
    expect(
      ids((await api("GET", `/v1/time-off?barberId=${b}`, asManager)).body),
    ).toEqual([upcomingB]);
    expect(
      ids(
        (await api("GET", "/v1/time-off", { host, token: account.token })).body,
      ),
    ).toEqual([upcomingA, closure].sort());
  });

  test("other branches and other tenants stay out of reach", async () => {
    const { tenant, host, branchId, asOwner } = await createShop();
    const second = await addBranch(host, asOwner.token);
    const manager = await createUser(tenant, "manager", {
      branchId: new ObjectId(branchId),
    });
    const away = await addBarber(host, asOwner.token, second);
    const span = { start: localDay(5, "10:00"), end: localDay(5, "12:00") };
    expect(
      (
        await api("POST", "/v1/time-off", {
          host,
          token: manager.token,
          body: { barberId: away, kind: "block", ...span },
        })
      ).status,
    ).toBe(404);

    const other = await createShop();
    const otherBarber = await addBarber(
      other.host,
      other.owner.token,
      other.branchId,
    );
    const entry = await api("POST", "/v1/time-off", {
      ...other.asOwner,
      body: { barberId: otherBarber, kind: "block", ...span },
    });
    expect(
      (await api("DELETE", `/v1/time-off/${entry.body.id}`, asOwner)).status,
    ).toBe(404);
    expect((await api("GET", "/v1/time-off", asOwner)).body).toEqual(
      [] as unknown as Record<string, never>,
    );
    expect(await barbers.countDocuments({ tenantId: other.tenant._id })).toBe(
      1,
    );
  });
});
