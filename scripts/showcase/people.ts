import type { ObjectId } from "mongodb";
import type { BarberDoc, Role, UserDoc } from "../../src/db/collections";
import { days } from "./catalog";
import {
  between,
  chance,
  DAY,
  oid,
  pick,
  type Rng,
  rngFor,
  TENANT_ID,
} from "./ids";

export const DOMAIN = "montecobre.test";
const tenantId = TENANT_ID;

type BarberSeed = {
  slug: string;
  name: string;
  branch: string;
  specialty: { es: string; en: string };
  bio: { es: string; en: string };
  hours: BarberDoc["hours"];
  services: string[];
  commissionBps?: number;
};

const CUTS = [
  "corte-signature",
  "fade-de-autor",
  "corte-tijera",
  "corte-nino",
  "barba-ritual",
  "perfilado-cejas",
];
const SPA = ["afeitado-navaja", "facial-carbon"];

export const BARBERS: BarberSeed[] = [
  {
    slug: "emilio",
    name: "Emilio Varela",
    branch: "polanco",
    specialty: { es: "Fades de autor", en: "Signature fades" },
    bio: {
      es: "Head barber. Doce años afinando degradados.",
      en: "Head barber. Twelve years perfecting fades.",
    },
    hours: days([1, 2, 3, 4, 5, 6], ["10:00", "14:00"], ["15:00", "20:00"]),
    services: [...CUTS, ...SPA],
    commissionBps: 5000,
  },
  {
    slug: "santiago",
    name: "Santiago Ríos",
    branch: "polanco",
    specialty: { es: "Tijera clásica", en: "Classic scissor work" },
    bio: {
      es: "Cortes clásicos con acabado natural.",
      en: "Classic cuts with a natural finish.",
    },
    hours: [
      ...days([2, 3, 4, 5, 6], ["10:00", "14:30"], ["15:30", "20:00"]),
      ...days([0], ["11:00", "16:00"]),
    ],
    services: CUTS,
    commissionBps: 4500,
  },
  {
    slug: "iker",
    name: "Iker Montaño",
    branch: "polanco",
    specialty: { es: "Afeitado a navaja", en: "Straight razor shaves" },
    bio: {
      es: "Toallas calientes y navaja de barbero.",
      en: "Hot towels and a barber's razor.",
    },
    hours: [
      ...days([1, 2, 4, 5, 6], ["11:00", "15:00"], ["16:00", "20:00"]),
      ...days([0], ["11:00", "16:00"]),
    ],
    services: [...CUTS, ...SPA],
    commissionBps: 4000,
  },
  {
    slug: "ricardo",
    name: "Ricardo Montes",
    branch: "polanco",
    specialty: { es: "Fundador", en: "Founder" },
    bio: {
      es: "Fundó Montecobre; atiende martes a jueves.",
      en: "Founded Montecobre; cuts Tuesday to Thursday.",
    },
    hours: days([2, 3, 4], ["11:00", "14:00"], ["15:00", "18:00"]),
    services: [
      "corte-signature",
      "corte-tijera",
      "barba-ritual",
      "afeitado-navaja",
    ],
  },
  {
    slug: "rodrigo",
    name: "Rodrigo Llamas",
    branch: "providencia",
    specialty: { es: "Texturas y crop", en: "Textures & crops" },
    bio: {
      es: "Cortes con textura y movimiento.",
      en: "Textured cuts with movement.",
    },
    hours: days([2, 3, 4, 5, 6], ["10:00", "14:00"], ["15:00", "20:00"]),
    services: [...CUTS, "facial-carbon"],
    commissionBps: 4500,
  },
  {
    slug: "mauricio",
    name: "Mauricio Ochoa",
    branch: "providencia",
    specialty: { es: "Barba y diseño", en: "Beard & design" },
    bio: { es: "Diseños de barba a medida.", en: "Custom beard designs." },
    hours: days([3, 4, 5, 6, 0], ["10:00", "14:00"], ["15:00", "19:00"]),
    services: [...CUTS, ...SPA],
    commissionBps: 4500,
  },
  {
    slug: "valeria",
    name: "Valeria Cuevas",
    branch: "providencia",
    specialty: {
      es: "Color y camuflaje de canas",
      en: "Colour & grey blending",
    },
    bio: { es: "Color natural para caballero.", en: "Natural colour for men." },
    hours: days([2, 3, 4, 5, 0], ["11:00", "15:00"], ["16:00", "20:00"]),
    services: [...CUTS, "camuflaje-canas", "facial-carbon"],
    commissionBps: 5000,
  },
  {
    slug: "andres",
    name: "Andrés Garza Leal",
    branch: "sanpedro",
    specialty: { es: "Ejecutivo clásico", en: "Executive classic" },
    bio: { es: "Cortes de oficina, impecables.", en: "Sharp office cuts." },
    hours: days([1, 2, 3, 4, 5], ["09:00", "13:00"], ["14:00", "18:00"]),
    services: [...CUTS, ...SPA],
    commissionBps: 4500,
  },
  {
    slug: "joaquin",
    name: "Joaquín Treviño",
    branch: "sanpedro",
    specialty: { es: "Fade y diseño", en: "Fades & designs" },
    bio: {
      es: "Líneas y diseños con máquina.",
      en: "Clipper lines and designs.",
    },
    hours: [
      ...days([1, 2, 3, 4, 5], ["10:00", "14:00"], ["15:00", "19:00"]),
      ...days([6], ["09:00", "14:00"], ["15:00", "19:00"]),
    ],
    services: CUTS,
    commissionBps: 4000,
  },
  {
    slug: "luisfernando",
    name: "Luis Fernando Salas",
    branch: "sanpedro",
    specialty: { es: "Rituales", en: "Rituals" },
    bio: {
      es: "Rituales de barba y faciales.",
      en: "Beard rituals and facials.",
    },
    hours: [
      ...days([2, 3, 4, 5], ["09:00", "13:00"], ["14:00", "17:00"]),
      ...days([6], ["09:00", "14:00"]),
    ],
    services: [...CUTS, ...SPA],
    commissionBps: 4500,
  },
];

export const MANAGERS = [
  { key: "polanco", name: "Mariana Robles" },
  { key: "providencia", name: "Héctor Ibarra" },
  { key: "sanpedro", name: "Paola Cantú" },
];

const FIRST = [
  "Alejandro",
  "Diego",
  "Javier",
  "Fernando",
  "Carlos",
  "Miguel",
  "Pablo",
  "Tomás",
  "Bruno",
  "Héctor",
  "Gael",
  "Mateo",
  "Leonardo",
  "Adrián",
  "Raúl",
  "Óscar",
  "Marco",
  "Arturo",
  "Iván",
  "Gerardo",
  "Rafael",
  "Hugo",
  "Manuel",
  "Rodrigo",
  "Lucía",
  "Andrea",
  "Sofía",
  "Camila",
];
const LAST = [
  "Hernández",
  "García",
  "Martínez",
  "López",
  "González",
  "Pérez",
  "Sánchez",
  "Ramírez",
  "Torres",
  "Flores",
  "Rivera",
  "Gómez",
  "Díaz",
  "Reyes",
  "Morales",
  "Cruz",
  "Ortiz",
  "Gutiérrez",
  "Chávez",
  "Ramos",
  "Vargas",
  "Castillo",
  "Jiménez",
  "Moreno",
  "Romero",
  "Herrera",
  "Medina",
  "Aguilar",
  "Vega",
  "Navarro",
];

/** How a customer behaves in the generated agenda. */
export type Profile = {
  id: ObjectId;
  name: string;
  kind: "account" | "guest" | "erased" | "demo";
  weight: number;
  /** Chance they miss a visit. */
  flaky: number;
  home: string;
  since: Date;
  until?: Date;
};

export type People = {
  users: UserDoc[];
  barbers: BarberDoc[];
  profiles: Profile[];
  ids: { owner: ObjectId; admin: ObjectId; demo: ObjectId };
  /** branch slug → manager user id. */
  managers: Map<string, ObjectId>;
};

const BRANCH_KEYS = ["polanco", "providencia", "sanpedro"];
const ago = (now: Date, d: number) => new Date(now.getTime() - d * DAY);

export function buildPeople(now: Date, passwordHash: string): People {
  const users: UserDoc[] = [];
  const created = ago(now, 420);
  const account = (
    key: string,
    email: string,
    name: string,
    role: Role,
    extra: Partial<UserDoc> = {},
  ): UserDoc => {
    const user: UserDoc = {
      _id: oid(`user:${key}`),
      tenantId,
      email,
      passwordHash,
      name,
      role,
      active: true,
      emailVerifiedAt: created,
      termsAcceptedAt: created,
      createdAt: created,
      updatedAt: created,
      ...extra,
    };
    users.push(user);
    return user;
  };
  const owner = account("owner", `owner@${DOMAIN}`, "Ricardo Montes", "owner");
  const admin = account("admin", `admin@${DOMAIN}`, "Daniela Ferrer", "admin");
  const managers = new Map<string, ObjectId>();
  for (const m of MANAGERS) {
    const user = account(
      `manager:${m.key}`,
      `${m.key}@${DOMAIN}`,
      m.name,
      "manager",
      { branchId: oid(`branch:${m.key}`) },
    );
    managers.set(m.key, user._id);
  }
  const barbers: BarberDoc[] = BARBERS.map((b) => {
    const branchId = oid(`branch:${b.branch}`);
    const userId =
      b.slug === "ricardo"
        ? owner._id
        : account(`barber:${b.slug}`, `${b.slug}@${DOMAIN}`, b.name, "barber", {
            branchId,
          })._id;
    return {
      _id: oid(`barber:${b.slug}`),
      tenantId,
      branchId,
      userId,
      slug: b.slug,
      name: b.name,
      specialty: b.specialty,
      bio: b.bio,
      images: [],
      hours: b.hours,
      serviceIds: b.services.map((s) => oid(`service:${s}`)),
      ...(b.commissionBps !== undefined && { commissionBps: b.commissionBps }),
      active: true,
      createdAt: created,
      updatedAt: created,
    };
  });

  const profiles: Profile[] = [];
  const demoSince = ago(now, 120);
  const demo = account(
    "customer:demo",
    `cliente@${DOMAIN}`,
    "Sebastián Herrera",
    "customer",
    {
      phone: "+525500001000",
      emailVerifiedAt: demoSince,
      termsAcceptedAt: demoSince,
      createdAt: demoSince,
      updatedAt: demoSince,
    },
  );
  profiles.push({
    id: demo._id,
    name: demo.name,
    kind: "demo",
    weight: 0,
    flaky: 0,
    home: "polanco",
    since: demoSince,
  });

  for (let i = 1; i <= 70; i++) {
    const n = String(i).padStart(3, "0");
    const rng = rngFor(`customer:${n}`);
    const since = ago(now, customerAge(rng));
    const name = `${pick(rng, FIRST)} ${pick(rng, LAST)}`;
    const user = account(
      `customer:${n}`,
      `c${n}@clientes.${DOMAIN}`,
      name,
      "customer",
      {
        ...(chance(rng, 0.8) && { phone: `+5255000020${n.slice(1)}` }),
        emailVerifiedAt: since,
        termsAcceptedAt: since,
        createdAt: since,
        updatedAt: since,
      },
    );
    profiles.push({
      id: user._id,
      name,
      kind: "account",
      weight: weightOf(rng),
      flaky: chance(rng, 0.08) ? 0.3 : 0.02,
      home: pick(rng, BRANCH_KEYS),
      since,
    });
  }
  for (let i = 1; i <= 10; i++) {
    const n = String(i).padStart(2, "0");
    const rng = rngFor(`guest:${n}`);
    const since = ago(now, between(rng, 3, 200));
    const name = `${pick(rng, FIRST)} ${pick(rng, LAST)}`;
    const guest: UserDoc = {
      _id: oid(`guest:${n}`),
      tenantId,
      name,
      phone: `+5255000030${n}`,
      guest: true,
      role: "customer",
      active: true,
      createdAt: since,
      updatedAt: since,
    };
    users.push(guest);
    profiles.push({
      id: guest._id,
      name,
      kind: "guest",
      weight: 0.4,
      flaky: chance(rng, 0.3) ? 0.35 : 0.04,
      home: pick(rng, BRANCH_KEYS),
      since,
    });
  }
  const erasedAt = ago(now, 30);
  const erased: UserDoc = {
    _id: oid("customer:erased"),
    tenantId,
    name: "Cliente eliminado",
    role: "customer",
    active: false,
    deletedAt: erasedAt,
    createdAt: ago(now, 300),
    updatedAt: erasedAt,
  };
  users.push(erased);
  profiles.push({
    id: erased._id,
    name: erased.name,
    kind: "erased",
    weight: 0.6,
    flaky: 0.02,
    home: "polanco",
    since: ago(now, 300),
    until: ago(now, 35),
  });

  return {
    users,
    barbers,
    profiles,
    ids: { owner: owner._id, admin: admin._id, demo: demo._id },
    managers,
  };
}

/** Days since signing up: mostly long-standing customers, some brand new. */
function customerAge(rng: Rng) {
  const roll = rng();
  if (roll < 0.12) return between(rng, 2, 14);
  if (roll < 0.35) return between(rng, 15, 90);
  return between(rng, 91, 400);
}

/** Visit frequency: a few regulars carry most of the agenda. */
const weightOf = (rng: Rng) => {
  const roll = rng();
  if (roll < 0.25) return 3;
  if (roll < 0.7) return 1.2;
  return 0.5;
};
