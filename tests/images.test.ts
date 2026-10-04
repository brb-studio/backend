import { expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { app } from "../src/app";
import { services } from "../src/db/collections";
import { api, createShop, createUser } from "./helpers";

// A real 1×1 PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);

const upload = (
  host: string,
  token: string,
  body: Uint8Array,
  type = "image/png",
) =>
  app.request("/v1/images", {
    method: "POST",
    headers: {
      "X-Forwarded-Host": host,
      Authorization: `Bearer ${token}`,
      "Content-Type": type,
    },
    body,
  });

test("staff upload a photo and anyone can fetch it by id, cached forever", async () => {
  const shop = await createShop();
  const res = await upload(shop.host, shop.owner.token, PNG);
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  expect(id).toMatch(/^[\w-]{22}$/);

  const image = await app.request(`/images/${id}`);
  expect(image.status).toBe(200);
  expect(image.headers.get("Content-Type")).toBe("image/png");
  expect(image.headers.get("Cache-Control")).toContain("immutable");
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
});

test("the type comes from the bytes: SVG and fake images are refused, big files too", async () => {
  const shop = await createShop();
  const svg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );
  expect(
    (await upload(shop.host, shop.owner.token, svg, "image/png")).status,
  ).toBe(415);
  expect(
    (await upload(shop.host, shop.owner.token, new Uint8Array(1024 * 1024 + 1)))
      .status,
  ).toBe(413);
  expect((await app.request("/images/not-an-id")).status).toBe(404);
  expect((await app.request(`/images/${"a".repeat(22)}`)).status).toBe(404);
});

test("customers and barbers can't upload", async () => {
  const shop = await createShop();
  for (const role of ["customer", "barber"] as const) {
    const { token } = await createUser(shop.tenant, role, {
      branchId: undefined,
    });
    expect((await upload(shop.host, token, PNG)).status).toBe(403);
  }
});

test("JSON bodies stay capped at 64 KB even though uploads may be 1 MB", async () => {
  const shop = await createShop();
  const res = await api("PATCH", "/v1/tenant", {
    ...shop.asOwner,
    body: { name: "x".repeat(70 * 1024) },
  });
  expect(res.status).toBe(413);
});

test("services keep a gallery in order; the first photo is the cover", async () => {
  const shop = await createShop();
  const gallery = [
    "/api/images/aaaaaaaaaaaaaaaaaaaaaa",
    "/api/images/bbbbbbbbbbbbbbbbbbbbbb",
  ];
  const created = await api("POST", "/v1/services", {
    ...shop.asOwner,
    body: {
      slug: "fade",
      name: { es: "Fade" },
      durationMin: 30,
      priceMinor: 1000,
      images: gallery,
    },
  });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ images: gallery, image: gallery[0] });

  const tooMany = await api("PATCH", `/v1/services/${created.body.id}`, {
    ...shop.asOwner,
    body: { images: Array.from({ length: 13 }, () => gallery[0]) },
  });
  expect(tooMany.status).toBe(422);
});

test("an older document with a single image reads as a one-photo gallery until a gallery is saved", async () => {
  const shop = await createShop();
  const created = await api("POST", "/v1/services", {
    ...shop.asOwner,
    body: {
      slug: "corte",
      name: { es: "Corte" },
      durationMin: 30,
      priceMinor: 1000,
    },
  });
  const id = String(created.body.id);
  await services.updateOne(
    { _id: new ObjectId(id) },
    { $set: { image: "/images/sample/haircut.jpg" } },
  );
  const legacy = await api("GET", `/v1/services/${id}`, shop.asOwner);
  expect(legacy.body).toMatchObject({
    images: ["/images/sample/haircut.jpg"],
    image: "/images/sample/haircut.jpg",
  });

  const cleared = await api("PATCH", `/v1/services/${id}`, {
    ...shop.asOwner,
    body: { images: [] },
  });
  expect(cleared.body.images).toEqual([]);
  expect(cleared.body.image).toBeUndefined();
  expect(
    (await services.findOne({ _id: new ObjectId(id) }))?.image,
  ).toBeUndefined();
});
