import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { PLAN_LIMITS } from "../src/features/tenancy/subscription";
import {
  addBarber,
  addBranch,
  api,
  branchInput,
  createShop,
  createUser,
} from "./helpers";

type Barber = { id: string; slug: string; branchId: string; userId?: string };
const list = (body: unknown) => body as Barber[];

describe("barbers", () => {
  test("a new barber works the branch's hours unless given their own", async () => {
    const { branchId, asOwner } = await createShop();
    const res = await api("POST", "/v1/barbers", {
      ...asOwner,
      body: {
        branchId,
        slug: "mateo",
        name: "Mateo",
        specialty: { es: "Degradados", en: "Fades" },
      },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      branchId,
      active: true,
      specialty: { es: "Degradados" },
    });
    expect(res.body.hours).toEqual(branchInput().hours);

    const own = [{ weekday: 2, open: "10:00", close: "18:00" }];
    const custom = await api("POST", "/v1/barbers", {
      ...asOwner,
      body: { branchId, slug: "lucas", name: "Lucas", hours: own },
    });
    expect(custom.body.hours).toEqual(own);

    for (const body of [
      {
        branchId,
        slug: "x1",
        name: "X",
        hours: [
          { weekday: 2, open: "10:00", close: "14:00" },
          { weekday: 2, open: "13:00", close: "18:00" },
        ],
      },
      { branchId, slug: "x2", name: "X", specialty: {} },
      {
        branchId,
        slug: "x3",
        name: "X",
        tenantId: new ObjectId().toHexString(),
      },
    ]) {
      expect(
        (await api("POST", "/v1/barbers", { ...asOwner, body })).status,
      ).toBe(422);
    }
    const dup = await api("POST", "/v1/barbers", {
      ...asOwner,
      body: { branchId, slug: "mateo", name: "Otro" },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error?.code).toBe("SLUG_TAKEN");
  });

  test("managers add barbers to their own branch only; barbers and customers cannot", async () => {
    const { tenant, host, branchId, asOwner } = await createShop();
    const other = await addBranch(host, asOwner.token);
    const branch = new ObjectId(branchId);
    const manager = await createUser(tenant, "manager", { branchId: branch });
    const barber = await createUser(tenant, "barber", { branchId: branch });
    const customer = await createUser(tenant, "customer");
    const body = (b: string) => ({
      branchId: b,
      slug: `s${new ObjectId()}`,
      name: "Nuevo",
    });

    expect(
      (
        await api("POST", "/v1/barbers", {
          host,
          token: manager.token,
          body: body(branchId),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api("POST", "/v1/barbers", {
          host,
          token: manager.token,
          body: body(other),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api("POST", "/v1/barbers", {
          host,
          token: barber.token,
          body: body(branchId),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api("POST", "/v1/barbers", {
          host,
          token: customer.token,
          body: body(branchId),
        })
      ).status,
    ).toBe(403);
  });

  test("each role sees the barbers of the branches it may", async () => {
    const { tenant, host, branchId, asOwner } = await createShop();
    const other = await addBranch(host, asOwner.token);
    const mine = await addBarber(host, asOwner.token, branchId);
    const theirs = await addBarber(host, asOwner.token, other);
    const manager = await createUser(tenant, "manager", {
      branchId: new ObjectId(branchId),
    });
    const barber = await createUser(tenant, "barber", {
      branchId: new ObjectId(branchId),
    });
    const ids = async (who: { host: string; token: string }, query = "") =>
      list((await api("GET", `/v1/barbers${query}`, who)).body)
        .map((b) => b.id)
        .sort();

    expect(await ids(asOwner)).toEqual([mine, theirs].sort());
    expect(await ids(asOwner, `?branchId=${other}`)).toEqual([theirs]);
    expect(await ids({ host, token: manager.token })).toEqual([mine]);
    expect(await ids({ host, token: barber.token })).toEqual([mine]);
    expect(
      (
        await api("GET", `/v1/barbers/${theirs}`, {
          host,
          token: manager.token,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api("PATCH", `/v1/barbers/${theirs}`, {
          host,
          token: manager.token,
          body: { name: "x" },
        })
      ).status,
    ).toBe(404);
  });

  test("tenant A cannot see, edit or add barbers in tenant B", async () => {
    const a = await createShop();
    const b = await createShop();
    const barberB = await addBarber(b.host, b.owner.token, b.branchId);
    expect((await api("GET", `/v1/barbers/${barberB}`, a.asOwner)).status).toBe(
      404,
    );
    expect(
      (
        await api("PATCH", `/v1/barbers/${barberB}`, {
          ...a.asOwner,
          body: { name: "x" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api("POST", "/v1/barbers", {
          ...a.asOwner,
          body: { branchId: b.branchId, slug: "intruso", name: "X" },
        })
      ).status,
    ).toBe(404);
    expect(list((await api("GET", "/v1/barbers", a.asOwner)).body)).toEqual([]);
  });

  test("the plan's barber limit counts active barbers", async () => {
    const { host, branchId, asOwner } = await createShop({
      subscription: {
        plan: "pro",
        status: "active",
        limits: { ...PLAN_LIMITS.pro, barbers: 1 },
      },
    });
    const first = await addBarber(host, asOwner.token, branchId);
    const over = await api("POST", "/v1/barbers", {
      ...asOwner,
      body: { branchId, slug: "dos", name: "Dos" },
    });
    expect(over.status).toBe(402);
    expect(over.body.error?.code).toBe("PLAN_LIMIT");
    await api("PATCH", `/v1/barbers/${first}`, {
      ...asOwner,
      body: { active: false },
    });
    expect(
      (
        await api("POST", "/v1/barbers", {
          ...asOwner,
          body: { branchId, slug: "dos", name: "Dos" },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api("PATCH", `/v1/barbers/${first}`, {
          ...asOwner,
          body: { active: true },
        })
      ).status,
    ).toBe(402);
  });

  test("a barber profile links to one barber account of its own branch", async () => {
    const { tenant, host, branchId, asOwner } = await createShop();
    const other = await addBranch(host, asOwner.token);
    const branch = new ObjectId(branchId);
    const account = await createUser(tenant, "barber", { branchId: branch });
    const managerAccount = await createUser(tenant, "manager", {
      branchId: branch,
    });
    const elsewhere = await createUser(tenant, "barber", {
      branchId: new ObjectId(other),
    });
    const profile = await addBarber(host, asOwner.token, branchId);
    const second = await addBarber(host, asOwner.token, branchId);
    const link = (id: string, userId: unknown) =>
      api("PATCH", `/v1/barbers/${id}`, { ...asOwner, body: { userId } });

    expect(
      (await link(profile, managerAccount.user._id.toHexString())).status,
    ).toBe(422);
    expect((await link(profile, elsewhere.user._id.toHexString())).status).toBe(
      422,
    );
    const linked = await link(profile, account.user._id.toHexString());
    expect(linked.body.userId).toBe(account.user._id.toHexString());
    const taken = await link(second, account.user._id.toHexString());
    expect(taken.status).toBe(409);
    expect(taken.body.error?.code).toBe("USER_LINKED");

    const move = { ...asOwner, body: { branchId: other } };
    const blocked = await api("PATCH", `/v1/users/${account.user._id}`, move);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error?.code).toBe("LINKED_BARBER");
    expect((await link(profile, null)).body.userId).toBeUndefined();
    expect(
      (await api("PATCH", `/v1/users/${account.user._id}`, move)).status,
    ).toBe(200);
  });
});

describe("public barbers", () => {
  test("active barbers of active branches, without internal fields", async () => {
    const { host, branchId, asOwner } = await createShop();
    const closedBranch = await addBranch(host, asOwner.token);
    const visible = await addBarber(host, asOwner.token, branchId, {
      slug: "mateo",
      specialty: { es: "Degradados" },
    });
    const inactive = await addBarber(host, asOwner.token, branchId);
    await addBarber(host, asOwner.token, closedBranch);
    await api("PATCH", `/v1/barbers/${inactive}`, {
      ...asOwner,
      body: { active: false },
    });
    await api("PATCH", `/v1/branches/${closedBranch}`, {
      ...asOwner,
      body: { active: false },
    });
    const branchSlug = String(
      (await api("GET", `/v1/branches/${branchId}`, asOwner)).body.slug,
    );

    const res = await api("GET", "/v1/public/barbers", { host });
    expect(res.body).toEqual([
      {
        id: visible,
        slug: "mateo",
        name: "Mateo",
        specialty: { es: "Degradados" },
        branch: branchSlug,
      },
    ] as unknown as typeof res.body);
    for (const leak of ["userId", "hours", "tenantId", "active"]) {
      expect(JSON.stringify(res.body)).not.toContain(leak);
    }
    expect(
      list(
        (await api("GET", `/v1/public/barbers?branch=${branchSlug}`, { host }))
          .body,
      ),
    ).toHaveLength(1);
    expect(
      (await api("GET", "/v1/public/barbers?branch=nope", { host })).status,
    ).toBe(404);
  });
});
