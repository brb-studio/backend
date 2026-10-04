// Demo data for development and end-to-end tests: two barbershops with staff and customer accounts.
//   bun run seed            adds whichever demo tenant is missing
//   bun run seed --reset    wipes the database first (only *_test or *_e2e databases)
// Every demo account uses DEMO_PASSWORD. Refuses to run with NODE_ENV=production.
import { parseArgs } from "node:util";
import { ObjectId } from "mongodb";
import { config } from "../src/config";
import { client, db } from "../src/db/client";
import {
  type BarberDoc,
  type BranchDoc,
  barbers,
  branches,
  type Hours,
  type PackageDoc,
  type PromotionDoc,
  packages,
  promotions,
  type Role,
  type ServiceDoc,
  services,
  specs,
  type TenantDoc,
  tenants,
  type UserDoc,
  users,
} from "../src/db/collections";
import { ensureCollections } from "../src/db/setup";
import { DEFAULT_BOOKING } from "../src/features/tenancy/schemas";
import { PLAN_LIMITS } from "../src/features/tenancy/subscription";

export const DEMO_PASSWORD = "demo1234";

const { values } = parseArgs({
  options: { reset: { type: "boolean", default: false } },
});

if (config.NODE_ENV === "production") {
  throw new Error("seed refuses to run in production");
}
if (values.reset) {
  if (!/_(test|e2e)$/.test(db.databaseName)) {
    throw new Error(
      `--reset only wipes *_test or *_e2e databases, not "${db.databaseName}"`,
    );
  }
  await db.dropDatabase();
}
await ensureCollections(db, specs);

const now = new Date();
const stamp = { createdAt: now, updatedAt: now };
const passwordHash = await Bun.password.hash(DEMO_PASSWORD);
const range = (
  from: number,
  to: number,
  open: string,
  close: string,
): Hours[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    weekday: from + i,
    open,
    close,
  }));

type Seed = {
  tenant: TenantDoc;
  branches: BranchDoc[];
  services: ServiceDoc[];
  packages: PackageDoc[];
  barbers: BarberDoc[];
  users: UserDoc[];
  promotions: PromotionDoc[];
};

/** Builders scoped to one tenant id. */
function builders(tenantId: ObjectId) {
  return {
    branch: (
      b: Omit<
        BranchDoc,
        "_id" | "tenantId" | "booking" | "active" | "createdAt" | "updatedAt"
      >,
    ): BranchDoc => ({
      _id: new ObjectId(),
      tenantId,
      booking: DEFAULT_BOOKING,
      active: true,
      ...stamp,
      ...b,
    }),
    service: (
      s: Omit<
        ServiceDoc,
        "_id" | "tenantId" | "active" | "createdAt" | "updatedAt"
      >,
    ): ServiceDoc => ({
      _id: new ObjectId(),
      tenantId,
      active: true,
      ...stamp,
      ...s,
    }),
    pkg: (
      p: Omit<
        PackageDoc,
        "_id" | "tenantId" | "active" | "createdAt" | "updatedAt"
      >,
    ): PackageDoc => ({
      _id: new ObjectId(),
      tenantId,
      active: true,
      ...stamp,
      ...p,
    }),
    barber: (
      home: BranchDoc,
      b: Pick<BarberDoc, "slug" | "name" | "specialty">,
      offered: ServiceDoc[],
    ): BarberDoc => ({
      _id: new ObjectId(),
      tenantId,
      branchId: home._id,
      hours: home.hours,
      serviceIds: offered.map((s) => s._id),
      active: true,
      ...stamp,
      ...b,
    }),
    /** A demo account; a barber account is linked to its barber profile. */
    user: (
      email: string,
      name: string,
      role: Role,
      barber?: BarberDoc,
      branch?: BranchDoc,
    ): UserDoc => {
      const user: UserDoc = {
        _id: new ObjectId(),
        tenantId,
        email,
        name,
        role,
        active: true,
        passwordHash,
        ...stamp,
        ...(barber || branch
          ? { branchId: (barber?.branchId ?? branch?._id) as ObjectId }
          : {}),
      };
      if (barber) barber.userId = user._id;
      return user;
    },
    promotion: (
      p: Pick<PromotionDoc, "name" | "type" | "value" | "firstVisitOnly"> &
        Partial<PromotionDoc>,
    ): PromotionDoc => ({
      _id: new ObjectId(),
      tenantId,
      branchIds: [],
      serviceIds: [],
      packageIds: [],
      redemptions: 0,
      active: true,
      ...stamp,
      ...p,
    }),
  };
}

function magicstudio(): Seed {
  const tenantId = new ObjectId();
  const make = builders(tenantId);
  const centro = make.branch({
    slug: "centro",
    name: "MagicStudio Centro",
    address: ["123 Sample Street", "Sample City"],
    phone: "+10000000000",
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=MagicStudio",
    images: ["/images/sample/branch-centro.jpg"],
    timeZone: "America/Mexico_City",
    hours: [...range(1, 5, "10:00", "20:00"), ...range(6, 6, "10:00", "18:00")],
  });
  const norte = make.branch({
    slug: "norte",
    name: "MagicStudio Norte",
    address: ["456 Example Avenue", "Sample City"],
    phone: "+10000000001",
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=MagicStudio",
    images: ["/images/sample/branch-norte.jpg"],
    timeZone: "America/Tijuana",
    hours: range(2, 6, "11:00", "21:00"),
  });
  const haircut = make.service({
    slug: "haircut",
    position: 1,
    durationMin: 45,
    priceMinor: 3500,
    name: { en: "Haircut", es: "Corte de pelo" },
    description: {
      en: "Consultation, cut and styling.",
      es: "Asesoría, corte y peinado.",
    },
    images: ["/images/sample/haircut.jpg"],
  });
  const beard = make.service({
    slug: "beard",
    position: 2,
    durationMin: 30,
    priceMinor: 2000,
    name: { en: "Beard trim", es: "Perfilado de barba" },
    description: {
      en: "Shape, line-up and hot towel.",
      es: "Forma, perfilado y toalla caliente.",
    },
    images: ["/images/sample/beard.jpg"],
  });
  const shave = make.service({
    slug: "shave",
    position: 4,
    durationMin: 40,
    priceMinor: 3000,
    name: { en: "Hot towel shave", es: "Afeitado clásico" },
    description: {
      en: "Straight razor, hot towel and balm.",
      es: "Navaja, toalla caliente y bálsamo.",
    },
    images: ["/images/sample/shave.jpg"],
  });
  const mateo = make.barber(
    centro,
    {
      slug: "mateo",
      name: "Mateo",
      specialty: { en: "Fades & tapers", es: "Degradados" },
    },
    [haircut, beard],
  );
  const lucas = make.barber(
    centro,
    {
      slug: "lucas",
      name: "Lucas",
      specialty: { en: "Classic cuts", es: "Cortes clásicos" },
    },
    [haircut, beard, shave],
  );
  const andres = make.barber(
    norte,
    {
      slug: "andres",
      name: "Andrés",
      specialty: { en: "Beard design", es: "Diseño de barba" },
    },
    [haircut, beard, shave],
  );
  return {
    tenant: {
      _id: tenantId,
      slug: "magicstudio",
      name: "MagicStudio",
      currency: "USD",
      locales: ["es", "en"],
      defaultLocale: "es",
      brand: {
        instagramUrl: "https://www.instagram.com/",
        authImage: "/images/sample/beard.jpg",
        coverImage: "/images/sample/cover.jpg",
      },
      subscription: {
        plan: "lifetime",
        status: "active",
        limits: PLAN_LIMITS.lifetime,
      },
      ...stamp,
    },
    branches: [centro, norte],
    services: [haircut, beard, shave],
    packages: [
      make.pkg({
        slug: "cut-and-beard",
        name: { en: "Cut & beard", es: "Corte y barba" },
        description: { en: "The full service.", es: "El servicio completo." },
        priceMinor: 5000,
        items: [{ serviceId: haircut._id }, { serviceId: beard._id }],
        images: ["/images/sample/cut-and-beard.jpg"],
        position: 3,
      }),
    ],
    barbers: [mateo, lucas, andres],
    users: [
      make.user("owner@magicstudio.test", "Dueña Demo", "owner"),
      make.user("admin@magicstudio.test", "Admin Demo", "admin"),
      make.user(
        "encargado@magicstudio.test",
        "Encargado Centro",
        "manager",
        undefined,
        centro,
      ),
      make.user("mateo@magicstudio.test", "Mateo", "barber", mateo),
      make.user("andres@magicstudio.test", "Andrés", "barber", andres),
      make.user("cliente@magicstudio.test", "Cliente Demo", "customer"),
    ],
    promotions: [
      make.promotion({
        name: { es: "Primera visita", en: "First visit" },
        type: "percent",
        value: 15,
        firstVisitOnly: true,
      }),
      make.promotion({
        name: { es: "Verano", en: "Summer" },
        code: "VERANO",
        type: "fixed",
        value: 500,
        firstVisitOnly: false,
        maxRedemptions: 100,
      }),
    ],
  };
}

function elite(): Seed {
  const tenantId = new ObjectId();
  const make = builders(tenantId);
  const tijuana = make.branch({
    slug: "tijuana",
    name: "Elite Tijuana",
    address: ["Av. Revolución 1234", "Zona Centro, Tijuana"],
    phone: "+526641234567",
    timeZone: "America/Tijuana",
    hours: range(1, 6, "09:00", "19:00"),
  });
  const corte = make.service({
    slug: "corte",
    position: 1,
    durationMin: 40,
    priceMinor: 25_000,
    name: { es: "Corte", en: "Haircut" },
    images: ["/images/sample/haircut.jpg"],
  });
  const barba = make.service({
    slug: "barba",
    position: 2,
    durationMin: 30,
    priceMinor: 18_000,
    name: { es: "Barba", en: "Beard" },
    images: ["/images/sample/beard.jpg"],
  });
  const fade = make.service({
    slug: "fade",
    position: 3,
    durationMin: 50,
    priceMinor: 30_000,
    name: { es: "Fade", en: "Fade" },
    images: ["/images/sample/cut-and-beard.jpg"],
  });
  const carlos = make.barber(
    tijuana,
    {
      slug: "carlos",
      name: "Carlos",
      specialty: { es: "Fades y diseños", en: "Fades & designs" },
    },
    [corte, barba, fade],
  );
  const diego = make.barber(
    tijuana,
    {
      slug: "diego",
      name: "Diego",
      specialty: { es: "Cortes clásicos", en: "Classic cuts" },
    },
    [corte, fade],
  );
  return {
    tenant: {
      _id: tenantId,
      slug: "elite",
      name: "Barbería Elite",
      currency: "MXN",
      locales: ["es", "en"],
      defaultLocale: "es",
      theme: {
        accent: "#2563eb",
        "accent-fg": "#ffffff",
        "accent-text": { light: "#1d4ed8", dark: "#93c5fd" },
      },
      brand: { instagramUrl: "https://www.instagram.com/" },
      subscription: { plan: "pro", status: "active", limits: PLAN_LIMITS.pro },
      ...stamp,
    },
    branches: [tijuana],
    services: [corte, barba, fade],
    packages: [
      make.pkg({
        slug: "corte-barba",
        name: { es: "Corte y barba", en: "Cut & beard" },
        priceMinor: 38_000,
        items: [{ serviceId: corte._id }, { serviceId: barba._id }],
        position: 4,
      }),
    ],
    barbers: [carlos, diego],
    users: [
      make.user("owner@elite.test", "Dueño Elite", "owner"),
      make.user("carlos@elite.test", "Carlos", "barber", carlos),
      make.user("cliente@elite.test", "Cliente Elite", "customer"),
    ],
    promotions: [
      make.promotion({
        name: { es: "Bienvenido", en: "Welcome" },
        code: "BIENVENIDO",
        type: "percent",
        value: 10,
        firstVisitOnly: true,
      }),
    ],
  };
}

const seeded: Seed[] = [];
for (const seed of [magicstudio(), elite()]) {
  if (await tenants.findOne({ slug: seed.tenant.slug })) {
    console.log(
      `"${seed.tenant.slug}" already exists in "${db.databaseName}"; skipped.`,
    );
    continue;
  }
  await Promise.all([
    tenants.insertOne(seed.tenant),
    branches.insertMany(seed.branches),
    services.insertMany(seed.services),
    packages.insertMany(seed.packages),
    barbers.insertMany(seed.barbers),
    users.insertMany(seed.users),
    promotions.insertMany(seed.promotions),
  ]);
  seeded.push(seed);
}
await client.close();

for (const seed of seeded) {
  console.log(
    `\n${seed.tenant.name} → http://${seed.tenant.slug}.localhost:3000  (db "${db.databaseName}")`,
  );
  for (const user of seed.users)
    console.log(`  ${user.role.padEnd(9)} ${user.email}`);
}
if (seeded.length > 0)
  console.log(`\nPassword for every demo account: ${DEMO_PASSWORD}`);
