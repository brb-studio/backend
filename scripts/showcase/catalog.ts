import type {
  BranchDoc,
  Hours,
  Localized,
  PackageDoc,
  ProductDoc,
  PromotionDoc,
  ServiceDoc,
  TenantDoc,
} from "../../src/db/collections";
import { DEFAULT_BOOKING } from "../../src/features/tenancy/schemas";
import { PLAN_LIMITS } from "../../src/features/tenancy/subscription";
import { DAY, oid, SLUG, TENANT_ID } from "./ids";
import { type ImageRefs, ref } from "./images";

export type Catalog = {
  tenant: TenantDoc;
  branches: BranchDoc[];
  services: ServiceDoc[];
  packages: PackageDoc[];
  products: ProductDoc[];
  promotions: PromotionDoc[];
};

const tenantId = TENANT_ID;
const ago = (now: Date, days: number) => new Date(now.getTime() - days * DAY);
const stampAt = (at: Date) => ({ createdAt: at, updatedAt: at });

export const days = (
  weekdays: number[],
  ...ranges: [string, string][]
): Hours[] =>
  weekdays.flatMap((weekday) =>
    ranges.map(([open, close]) => ({ weekday, open, close })),
  );

const MON_SAT = [1, 2, 3, 4, 5, 6];

function branches(now: Date, img: ImageRefs): BranchDoc[] {
  const base = {
    tenantId,
    booking: { ...DEFAULT_BOOKING, windowDays: 30 },
    active: true,
    ...stampAt(ago(now, 420)),
  };
  return [
    {
      ...base,
      _id: oid("branch:polanco"),
      slug: "polanco",
      name: "Montecobre Polanco",
      address: ["Calle Cedro Azul 214", "Polanco, Ciudad de México"],
      phone: "+525500000101",
      images: ref(img, "branch-centro.jpg", "cover.jpg"),
      timeZone: "America/Mexico_City",
      hours: [
        ...days(MON_SAT, ["10:00", "20:00"]),
        ...days([0], ["11:00", "16:00"]),
      ],
    },
    {
      ...base,
      _id: oid("branch:providencia"),
      slug: "providencia",
      name: "Montecobre Providencia",
      address: ["Av. Los Almendros 1580", "Providencia, Guadalajara"],
      phone: "+525500000102",
      images: ref(img, "branch-norte.jpg"),
      timeZone: "America/Mexico_City",
      hours: days([2, 3, 4, 5, 6, 0], ["10:00", "20:00"]),
    },
    {
      ...base,
      _id: oid("branch:sanpedro"),
      slug: "sanpedro",
      name: "Montecobre San Pedro",
      address: ["Calzada del Roble 402", "Del Valle, San Pedro Garza García"],
      phone: "+525500000103",
      images: ref(img, "cover.jpg"),
      timeZone: "America/Monterrey",
      hours: [
        ...days([1, 2, 3, 4, 5], ["09:00", "19:00"]),
        ...days([6], ["09:00", "14:00"], ["15:00", "19:00"]),
      ],
    },
  ];
}

type ServiceSeed = [
  slug: string,
  minutes: number,
  priceMinor: number,
  name: Localized,
  description: Localized,
  image?: string,
];

const SERVICES: ServiceSeed[] = [
  [
    "corte-signature",
    60,
    45_000,
    { es: "Corte Signature", en: "Signature cut" },
    {
      es: "Asesoría, lavado, corte a tijera y máquina, peinado con producto.",
      en: "Consultation, wash, scissor and clipper cut, styled with product.",
    },
    "haircut.jpg",
  ],
  [
    "fade-de-autor",
    50,
    42_000,
    { es: "Fade de autor", en: "Signature fade" },
    {
      es: "Degradado a medida, perfilado con navaja y acabado mate.",
      en: "Custom fade, razor line-up and matte finish.",
    },
    "cut-and-beard.jpg",
  ],
  [
    "corte-tijera",
    60,
    48_000,
    { es: "Corte clásico a tijera", en: "Classic scissor cut" },
    {
      es: "Solo tijera, para cabello medio y largo.",
      en: "Scissors only, for medium and long hair.",
    },
    "haircut.jpg",
  ],
  [
    "barba-ritual",
    40,
    32_000,
    { es: "Barba ritual", en: "Beard ritual" },
    {
      es: "Diseño, toalla caliente, aceite y bálsamo.",
      en: "Shaping, hot towel, oil and balm.",
    },
    "beard.jpg",
  ],
  [
    "afeitado-navaja",
    45,
    38_000,
    { es: "Afeitado clásico a navaja", en: "Straight razor shave" },
    {
      es: "Doble pasada, toallas calientes y tónico.",
      en: "Two passes, hot towels and tonic.",
    },
    "shave.jpg",
  ],
  [
    "corte-nino",
    40,
    28_000,
    { es: "Corte niño", en: "Kids cut" },
    { es: "Hasta 12 años.", en: "Up to 12 years old." },
  ],
  [
    "perfilado-cejas",
    15,
    12_000,
    { es: "Perfilado de cejas", en: "Brow tidy" },
    { es: "Limpieza con navaja y tijera.", en: "Razor and scissor clean-up." },
  ],
  [
    "facial-carbon",
    30,
    35_000,
    { es: "Facial de carbón", en: "Charcoal facial" },
    {
      es: "Limpieza profunda, mascarilla y vapor.",
      en: "Deep clean, mask and steam.",
    },
  ],
  [
    "camuflaje-canas",
    45,
    52_000,
    { es: "Camuflaje de canas", en: "Grey blending" },
    {
      es: "Color natural que suaviza las canas. Solo en Providencia.",
      en: "Natural colour that softens grey. Providencia only.",
    },
  ],
];

export const CUT_SERVICES = [
  "corte-signature",
  "fade-de-autor",
  "corte-tijera",
  "corte-nino",
];

function services(now: Date, img: ImageRefs): ServiceDoc[] {
  return SERVICES.map(
    ([slug, durationMin, priceMinor, name, description, image], i) => ({
      _id: oid(`service:${slug}`),
      tenantId,
      ...(slug === "camuflaje-canas" && {
        branchId: oid("branch:providencia"),
      }),
      slug,
      name,
      description,
      durationMin,
      priceMinor,
      images: image ? ref(img, image) : [],
      position: i + 1,
      active: true,
      ...stampAt(ago(now, 410)),
    }),
  );
}

const PACKAGES: [string, number, Localized, string[], Localized][] = [
  [
    "ritual-montecobre",
    99_000,
    { es: "Ritual Montecobre", en: "Montecobre ritual" },
    ["corte-signature", "barba-ritual", "facial-carbon"],
    {
      es: "Corte, barba y facial: la experiencia completa.",
      en: "Cut, beard and facial: the full experience.",
    },
  ],
  [
    "corte-barba",
    69_000,
    { es: "Corte y barba", en: "Cut & beard" },
    ["corte-signature", "barba-ritual"],
    { es: "El combo de siempre.", en: "The classic combo." },
  ],
  [
    "padre-e-hijo",
    65_000,
    { es: "Padre e hijo", en: "Father & son" },
    ["corte-signature", "corte-nino"],
    { es: "Dos cortes, una cita.", en: "Two cuts, one visit." },
  ],
  [
    "dia-del-novio",
    125_000,
    { es: "Día del novio", en: "Groom's day" },
    ["corte-signature", "afeitado-navaja", "facial-carbon", "perfilado-cejas"],
    { es: "Todo listo para el gran día.", en: "Ready for the big day." },
  ],
];

function packages(now: Date, img: ImageRefs): PackageDoc[] {
  return PACKAGES.map(([slug, priceMinor, name, items, description], i) => ({
    _id: oid(`package:${slug}`),
    tenantId,
    slug,
    name,
    description,
    priceMinor,
    items: items.map((s) => ({ serviceId: oid(`service:${s}`) })),
    images: ref(img, "cut-and-beard.jpg"),
    position: SERVICES.length + i + 1,
    active: true,
    ...stampAt(ago(now, 400)),
  }));
}

const PRODUCTS: [string, number, Localized, string, Partial<ProductDoc>?][] = [
  [
    "pomada-mate",
    34_000,
    { es: "Pomada mate 90 g", en: "Matte pomade 90 g" },
    "Styling",
  ],
  [
    "pomada-brillo",
    34_000,
    { es: "Pomada brillo 90 g", en: "Shine pomade 90 g" },
    "Styling",
    { stock: 0 },
  ],
  [
    "aceite-barba",
    39_000,
    { es: "Aceite para barba 30 ml", en: "Beard oil 30 ml" },
    "Barba",
  ],
  [
    "balsamo-barba",
    36_000,
    { es: "Bálsamo para barba", en: "Beard balm" },
    "Barba",
  ],
  [
    "shampoo-carbon",
    31_000,
    { es: "Shampoo de carbón", en: "Charcoal shampoo" },
    "Cuidado",
  ],
  [
    "tonico-aftershave",
    42_000,
    { es: "Tónico aftershave", en: "Aftershave tonic" },
    "Cuidado",
  ],
  [
    "cera-bigote",
    22_000,
    { es: "Cera para bigote", en: "Moustache wax" },
    "Barba",
    { active: false },
  ],
  [
    "peine-acetato",
    18_000,
    { es: "Peine de acetato", en: "Acetate comb" },
    "Accesorios",
  ],
  [
    "kit-regalo",
    129_000,
    { es: "Kit regalo Montecobre", en: "Montecobre gift kit" },
    "Regalo",
    { stock: 3 },
  ],
];

function products(now: Date): ProductDoc[] {
  return PRODUCTS.map(([slug, priceMinor, name, category, extra], i) => ({
    _id: oid(`product:${slug}`),
    tenantId,
    slug,
    name,
    priceMinor,
    category,
    position: i + 1,
    active: true,
    ...stampAt(ago(now, 200)),
    ...extra,
  }));
}

/** Products a customer can actually take home (active and not sold out). */
export const SELLABLE = PRODUCTS.filter(
  ([, , , , extra]) => extra?.active !== false && extra?.stock !== 0,
).map(([slug]) => slug);

export const PROMO = {
  firstVisit: oid("promo:primera-visita"),
  loyalty: oid("promo:lealtad"),
  cobre100: oid("promo:cobre100"),
  ritual: oid("promo:ritual"),
  buenFin: oid("promo:buenfin"),
  verano: oid("promo:verano"),
};

function promotions(now: Date): PromotionDoc[] {
  const base = {
    tenantId,
    branchIds: [],
    serviceIds: [],
    packageIds: [],
    firstVisitOnly: false,
    redemptions: 0,
    active: true,
  };
  return [
    {
      ...base,
      _id: PROMO.firstVisit,
      name: { es: "Primera visita", en: "First visit" },
      type: "percent",
      value: 15,
      firstVisitOnly: true,
      ...stampAt(ago(now, 380)),
    },
    {
      ...base,
      _id: PROMO.loyalty,
      name: {
        es: "Cada 6.ª visita: 50 % en tu corte",
        en: "Every 6th visit: 50% off your cut",
      },
      type: "percent",
      value: 50,
      everyVisits: 6,
      serviceIds: CUT_SERVICES.map((s) => oid(`service:${s}`)),
      ...stampAt(ago(now, 60)),
    },
    {
      ...base,
      _id: PROMO.cobre100,
      name: { es: "$100 de descuento", en: "MXN 100 off" },
      code: "COBRE100",
      type: "fixed",
      value: 10_000,
      minSubtotalMinor: 60_000,
      maxRedemptions: 200,
      ...stampAt(ago(now, 90)),
    },
    {
      ...base,
      _id: PROMO.ritual,
      name: { es: "Ritual con 10 %", en: "Ritual 10% off" },
      code: "RITUAL",
      type: "percent",
      value: 10,
      packageIds: [oid("package:ritual-montecobre")],
      maxPerCustomer: 1,
      ...stampAt(ago(now, 60)),
    },
    {
      ...base,
      _id: PROMO.buenFin,
      name: { es: "Buen Fin", en: "Buen Fin weekend" },
      code: "BUENFIN",
      type: "percent",
      value: 20,
      startsAt: new Date(now.getTime() + 20 * DAY),
      endsAt: new Date(now.getTime() + 24 * DAY),
      ...stampAt(ago(now, 3)),
    },
    {
      ...base,
      _id: PROMO.verano,
      name: { es: "Verano", en: "Summer" },
      code: "VERANO",
      type: "fixed",
      value: 5_000,
      active: false,
      startsAt: ago(now, 140),
      endsAt: ago(now, 80),
      ...stampAt(ago(now, 150)),
    },
  ];
}

export function buildCatalog(now: Date, img: ImageRefs): Catalog {
  return {
    tenant: {
      _id: TENANT_ID,
      slug: SLUG,
      name: "Montecobre Barber Co.",
      currency: "MXN",
      locales: ["es", "en"],
      defaultLocale: "es",
      theme: {
        accent: "#2f9e6f",
        "accent-fg": "#0b1a13",
        "accent-text": { light: "#1f7a53", dark: "#6fd3a5" },
      },
      brand: {
        instagramUrl: "https://www.instagram.com/",
        ...(img.has("cover.jpg") && { coverImage: ref(img, "cover.jpg")[0] }),
        ...(img.has("beard.jpg") && { authImage: ref(img, "beard.jpg")[0] }),
      },
      subscription: { plan: "pro", status: "active", limits: PLAN_LIMITS.pro },
      reminders: { enabled: true },
      products: { enabled: true },
      ...stampAt(ago(now, 425)),
    },
    branches: branches(now, img),
    services: services(now, img),
    packages: packages(now, img),
    products: products(now),
    promotions: promotions(now),
  };
}
