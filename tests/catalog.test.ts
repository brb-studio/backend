import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { addBarber, addBranch, api, createShop, createUser } from "./helpers";

type Who = { host: string; token: string };
type Item = { id: string; slug: string };
const slugs = (body: unknown) => (body as Item[]).map((i) => i.slug);

async function create(who: Who, path: string, body: Record<string, unknown>) {
  const res = await api("POST", path, { ...who, body });
  if (res.status !== 201)
    throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
  return String(res.body.id);
}

const service = (
  slug: string,
  durationMin: number,
  priceMinor: number,
  extra = {},
) => ({
  slug,
  name: { es: slug, en: slug },
  durationMin,
  priceMinor,
  ...extra,
});
const items = (...ids: string[]) => ids.map((serviceId) => ({ serviceId }));

describe("services", () => {
  test("each service has its own duration and price, as integers", async () => {
    const { asOwner } = await createShop();
    const other = await createShop();
    for (const minutes of [30, 45, 90]) {
      const res = await api("POST", "/v1/services", {
        ...asOwner,
        body: service(`s${minutes}`, minutes, 30_000),
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        durationMin: minutes,
        priceMinor: 30_000,
        active: true,
        position: 0,
      });
    }
    for (const [body, status] of [
      [service("x", 0, 100), 422],
      [service("x", 45.5, 100), 422],
      [service("x", 721, 100), 422],
      [service("x", 45, 299.99), 422],
      [service("x", 45, -1), 422],
      [{ ...service("x", 45, 100), name: {} }, 422],
      [
        { ...service("x", 45, 100), tenantId: new ObjectId().toHexString() },
        422,
      ],
      [service("x", 45, 100, { branchId: other.branchId }), 404],
      [service("s30", 45, 100), 409],
    ] as const) {
      expect(
        (await api("POST", "/v1/services", { ...asOwner, body })).status,
      ).toBe(status);
    }
  });

  test("only owners and admins edit the catalog; others see tenant-wide plus their branch", async () => {
    const { tenant, host, branchId, asOwner } = await createShop();
    const otherBranch = await addBranch(host, asOwner.token);
    const everywhere = await create(
      asOwner,
      "/v1/services",
      service("corte", 45, 30_000),
    );
    const here = await create(
      asOwner,
      "/v1/services",
      service("aqui", 30, 10_000, { branchId }),
    );
    const there = await create(
      asOwner,
      "/v1/services",
      service("alla", 30, 10_000, { branchId: otherBranch }),
    );
    const manager = await createUser(tenant, "manager", {
      branchId: new ObjectId(branchId),
    });
    const barber = await createUser(tenant, "barber", {
      branchId: new ObjectId(branchId),
    });
    const customer = await createUser(tenant, "customer");
    const asManager = { host, token: manager.token };

    expect(
      (
        await api("POST", "/v1/services", {
          ...asManager,
          body: service("nuevo", 30, 1),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api("PATCH", `/v1/services/${here}`, {
          host,
          token: barber.token,
          body: { priceMinor: 1 },
        })
      ).status,
    ).toBe(403);
    expect(
      (await api("GET", "/v1/services", { host, token: customer.token }))
        .status,
    ).toBe(403);
    expect(
      slugs((await api("GET", "/v1/services", asManager)).body).sort(),
    ).toEqual(["aqui", "corte"]);
    expect(
      slugs((await api("GET", "/v1/services", asOwner)).body),
    ).toHaveLength(3);
    expect((await api("GET", `/v1/services/${there}`, asManager)).status).toBe(
      404,
    );
    expect(
      (await api("GET", `/v1/services/${everywhere}`, asManager)).status,
    ).toBe(200);
  });
});

describe("packages", () => {
  test("keeps its own price; duration and list price come from its services, in order", async () => {
    const { asOwner } = await createShop();
    const corte = await create(
      asOwner,
      "/v1/services",
      service("corte", 45, 30_000),
    );
    const barba = await create(
      asOwner,
      "/v1/services",
      service("barba", 30, 20_000),
    );
    const masaje = await create(
      asOwner,
      "/v1/services",
      service("masaje", 30, 25_000),
    );
    const pkg = (slug: string, priceMinor: number, list: string[]) =>
      api("POST", "/v1/packages", {
        ...asOwner,
        body: { slug, name: { es: slug }, priceMinor, items: items(...list) },
      });

    const cb = await pkg("corte-barba", 45_000, [corte, barba]);
    expect(cb.status).toBe(201);
    expect(cb.body).toMatchObject({
      durationMin: 75,
      priceMinor: 45_000,
      listPriceMinor: 50_000,
      servicesActive: true,
    });

    const premium = await pkg("premium", 65_000, [corte, barba, masaje]);
    expect(premium.body).toMatchObject({
      durationMin: 105,
      priceMinor: 65_000,
      listPriceMinor: 75_000,
    });
    expect(premium.body.items).toEqual(
      items(corte, barba, masaje) as unknown as typeof premium.body.items,
    );

    expect(
      (await pkg("doble-corte", 50_000, [corte, corte])).body,
    ).toMatchObject({ durationMin: 90 });

    await api("PATCH", `/v1/services/${corte}`, {
      ...asOwner,
      body: { durationMin: 60, priceMinor: 35_000 },
    });
    expect(
      (await api("GET", `/v1/packages/${cb.body.id}`, asOwner)).body,
    ).toMatchObject({
      durationMin: 90,
      listPriceMinor: 55_000,
      priceMinor: 45_000,
    });

    await api("PATCH", `/v1/services/${barba}`, {
      ...asOwner,
      body: { active: false },
    });
    expect(
      (await api("GET", `/v1/packages/${cb.body.id}`, asOwner)).body
        .servicesActive,
    ).toBe(false);
  });

  test("items are 2–10 existing, active services that fit the package's branch", async () => {
    const { host, branchId, asOwner } = await createShop();
    const otherBranch = await addBranch(host, asOwner.token);
    const other = await createShop();
    const corte = await create(
      asOwner,
      "/v1/services",
      service("corte", 45, 30_000),
    );
    const barba = await create(
      asOwner,
      "/v1/services",
      service("barba", 30, 20_000),
    );
    const here = await create(
      asOwner,
      "/v1/services",
      service("aqui", 15, 10_000, { branchId }),
    );
    const there = await create(
      asOwner,
      "/v1/services",
      service("alla", 15, 10_000, { branchId: otherBranch }),
    );
    const off = await create(
      asOwner,
      "/v1/services",
      service("apagado", 15, 10_000),
    );
    await api("PATCH", `/v1/services/${off}`, {
      ...asOwner,
      body: { active: false },
    });
    const foreign = await create(
      other.asOwner,
      "/v1/services",
      service("ajeno", 15, 10_000),
    );
    let n = 0;
    const post = (list: string[], extra = {}) =>
      api("POST", "/v1/packages", {
        ...asOwner,
        body: {
          slug: `p${n++}`,
          name: { es: "Paquete" },
          priceMinor: 40_000,
          items: items(...list),
          ...extra,
        },
      });

    for (const list of [
      [corte],
      Array(11).fill(corte),
      [corte, new ObjectId().toHexString()],
      [corte, foreign],
      [corte, off],
      [corte, here],
    ]) {
      expect((await post(list)).status).toBe(422);
    }
    expect((await post([corte, here], { branchId })).status).toBe(201);
    expect((await post([corte, there], { branchId })).status).toBe(422);
    expect(
      (await post([corte, barba], { branchId: other.branchId })).status,
    ).toBe(404);
  });
});

describe("barber services", () => {
  test("a barber offers services of their own branch; repeats are dropped", async () => {
    const { host, branchId, asOwner } = await createShop();
    const otherBranch = await addBranch(host, asOwner.token);
    const other = await createShop();
    const corte = await create(
      asOwner,
      "/v1/services",
      service("corte", 45, 30_000),
    );
    const barba = await create(
      asOwner,
      "/v1/services",
      service("barba", 30, 20_000),
    );
    const there = await create(
      asOwner,
      "/v1/services",
      service("alla", 15, 10_000, { branchId: otherBranch }),
    );
    const foreign = await create(
      other.asOwner,
      "/v1/services",
      service("ajeno", 15, 10_000),
    );

    const created = await api("POST", "/v1/barbers", {
      ...asOwner,
      body: { branchId, slug: "mateo", name: "Mateo", serviceIds: [corte] },
    });
    expect(created.body.serviceIds).toEqual([
      corte,
    ] as unknown as typeof created.body.serviceIds);
    const patch = (serviceIds: string[]) =>
      api("PATCH", `/v1/barbers/${created.body.id}`, {
        ...asOwner,
        body: { serviceIds },
      });
    expect((await patch([corte, corte, barba])).body.serviceIds).toEqual([
      corte,
      barba,
    ] as unknown as never);
    expect((await patch([there])).status).toBe(422);
    expect((await patch([foreign])).status).toBe(422);
  });
});

async function catalogShop() {
  const shop = await createShop();
  const { host, asOwner } = shop;
  const centro = await addBranch(host, asOwner.token, { slug: "centro" });
  const norte = await addBranch(host, asOwner.token, { slug: "norte" });
  const svc = (
    slug: string,
    min: number,
    price: number,
    position: number,
    extra = {},
  ) =>
    create(
      asOwner,
      "/v1/services",
      service(slug, min, price, { position, ...extra }),
    );
  const corte = await svc("corte", 45, 30_000, 1);
  const barba = await svc("barba", 30, 20_000, 2);
  const masaje = await svc("masaje", 30, 25_000, 3);
  const diseno = await svc("diseno", 15, 10_000, 4, { branchId: norte });
  const nadie = await svc("nadie", 20, 10_000, 5);
  const apagado = await svc("apagado", 20, 10_000, 6);
  const pkg = (
    slug: string,
    priceMinor: number,
    position: number,
    list: string[],
    extra = {},
  ) =>
    create(asOwner, "/v1/packages", {
      slug,
      name: { es: slug },
      priceMinor,
      position,
      items: items(...list),
      ...extra,
    });
  await pkg("corte-barba", 45_000, 1, [corte, barba]);
  await pkg("premium", 65_000, 2, [corte, barba, masaje]);
  await pkg("con-diseno", 35_000, 3, [corte, diseno], { branchId: norte });
  await pkg("con-apagado", 35_000, 4, [corte, apagado]);
  const barber = (branchId: string, name: string, serviceIds: string[]) =>
    addBarber(host, asOwner.token, branchId, {
      slug: name.toLowerCase(),
      name,
      serviceIds,
    });
  await barber(centro, "Mateo", [corte, barba]);
  await barber(centro, "Lucas", [corte, barba, masaje, apagado]);
  await barber(norte, "Andres", [corte, diseno]);
  const ghost = await barber(centro, "Ghost", [nadie]);
  await api("PATCH", `/v1/barbers/${ghost}`, {
    ...asOwner,
    body: { active: false },
  });
  await api("PATCH", `/v1/services/${apagado}`, {
    ...asOwner,
    body: { active: false },
  });
  return { ...shop, barba };
}

describe("public catalog", () => {
  test("lists what at least one active barber can do, per branch or overall", async () => {
    const { host, asOwner, barba } = await catalogShop();
    const catalog = async (query = "") =>
      (await api("GET", `/v1/public/catalog${query}`, { host })).body;

    const centro = await catalog("?branch=centro");
    expect(slugs(centro.services)).toEqual(["corte", "barba", "masaje"]);
    expect(slugs(centro.packages)).toEqual(["corte-barba", "premium"]);
    const norte = await catalog("?branch=norte");
    expect(slugs(norte.services)).toEqual(["corte", "diseno"]);
    expect(slugs(norte.packages)).toEqual(["con-diseno"]);
    const all = await catalog();
    expect(slugs(all.services)).toEqual(["corte", "barba", "masaje", "diseno"]);
    expect(slugs(all.packages)).toEqual([
      "corte-barba",
      "premium",
      "con-diseno",
    ]);

    expect(all.currency).toBe("MXN");
    const premium = (all.packages as { slug: string }[]).find(
      (p) => p.slug === "premium",
    );
    expect(premium).toMatchObject({
      durationMin: 105,
      priceMinor: 65_000,
      listPriceMinor: 75_000,
    });
    expect(
      slugs((premium as unknown as { services: unknown }).services),
    ).toEqual(["corte", "barba", "masaje"]);
    for (const leak of [
      "tenantId",
      "active",
      "serviceIds",
      "branchId",
      "position",
    ]) {
      expect(JSON.stringify(all)).not.toContain(leak);
    }
    expect(
      (await api("GET", "/v1/public/catalog?branch=nope", { host })).status,
    ).toBe(404);

    await api("PATCH", `/v1/services/${barba}`, {
      ...asOwner,
      body: { active: false },
    });
    const after = await catalog("?branch=centro");
    expect(slugs(after.services)).toEqual(["corte", "masaje"]);
    expect(slugs(after.packages)).toEqual([]);
  });

  test("public barbers filter by what they can do", async () => {
    const { host } = await catalogShop();
    const names = async (query: string) =>
      (
        (await api("GET", `/v1/public/barbers${query}`, { host }))
          .body as unknown as { name: string }[]
      ).map((b) => b.name);

    expect(await names("?service=masaje")).toEqual(["Lucas"]);
    expect(await names("?package=premium")).toEqual(["Lucas"]);
    expect(await names("?package=corte-barba")).toEqual(["Lucas", "Mateo"]);
    expect(await names("?package=con-diseno")).toEqual(["Andres"]);
    expect(await names("?branch=centro&package=con-diseno")).toEqual([]);
    expect(await names("?service=nadie")).toEqual([]);
    expect(
      (await api("GET", "/v1/public/barbers?service=nope", { host })).status,
    ).toBe(404);
    expect(
      (await api("GET", "/v1/public/barbers?package=con-apagado", { host }))
        .status,
    ).toBe(404);
    expect(
      (
        await api("GET", "/v1/public/barbers?service=corte&package=premium", {
          host,
        })
      ).status,
    ).toBe(422);
  });

  test("tenant A cannot see or edit tenant B's catalog", async () => {
    const a = await createShop();
    const b = await createShop();
    const serviceB = await create(
      b.asOwner,
      "/v1/services",
      service("corte", 45, 30_000),
    );
    const serviceB2 = await create(
      b.asOwner,
      "/v1/services",
      service("barba", 30, 20_000),
    );
    const packageB = await create(b.asOwner, "/v1/packages", {
      slug: "combo",
      name: { es: "Combo" },
      priceMinor: 45_000,
      items: items(serviceB, serviceB2),
    });
    expect(
      (await api("GET", `/v1/services/${serviceB}`, a.asOwner)).status,
    ).toBe(404);
    expect(
      (
        await api("PATCH", `/v1/services/${serviceB}`, {
          ...a.asOwner,
          body: { priceMinor: 1 },
        })
      ).status,
    ).toBe(404);
    expect(
      (await api("GET", `/v1/packages/${packageB}`, a.asOwner)).status,
    ).toBe(404);
    expect(
      (
        await api("PATCH", `/v1/packages/${packageB}`, {
          ...a.asOwner,
          body: { priceMinor: 1 },
        })
      ).status,
    ).toBe(404);
    expect((await api("GET", "/v1/services", a.asOwner)).body).toEqual(
      [] as unknown as Record<string, never>,
    );
    expect(
      (await api("GET", `/v1/services/${serviceB}`, b.asOwner)).body.priceMinor,
    ).toBe(30_000);
  });
});
