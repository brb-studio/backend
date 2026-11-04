/**
 * Who the generated shop is. Defaults build Montecobre (screenshots, tests); `seed:qa` sets the
 * SHOWCASE_* variables before importing these modules to build the same shop under another name.
 */
const env = process.env;

/** A branch's public face; the key ("polanco"…) stays, since ids, slugs and emails hang from it. */
export type Place = { name: string; address: string[]; phone: string };

export const BRAND = {
  /** Tenant slug: subdomain and key of every deterministic id. */
  slug: env.SHOWCASE_SLUG ?? "montecobre",
  /** Short name used in branch, package and product names ("Montecobre Polanco"). */
  short: env.SHOWCASE_SHORT ?? "Montecobre",
  /** Full tenant name. */
  name: env.SHOWCASE_NAME ?? "Montecobre Barber Co.",
  /** Every account's password (local only). */
  password: env.SHOWCASE_PASSWORD ?? "montecobre-demo",
  /** One IANA zone for every branch; unset keeps each branch's own (Mexico City, Monterrey). */
  timeZone: env.SHOWCASE_TIMEZONE,
  /** Branch key → name, address and phone, as JSON; unset keeps the defaults. */
  places: (env.SHOWCASE_PLACES
    ? JSON.parse(env.SHOWCASE_PLACES)
    : {}) as Partial<Record<string, Place>>,
};

/** A branch's place and zone: the brand's override, or the default. */
export const placeOf = (key: string, fallback: Place, timeZone: string) => ({
  ...(BRAND.places[key] ?? fallback),
  timeZone: BRAND.timeZone ?? timeZone,
});
