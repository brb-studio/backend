# MagicStudio backend

API for MagicStudio, a multi-tenant SaaS for barbershops. Bun · Hono · Zod · MongoDB. The frontend is [brb-studio/frontend](https://github.com/brb-studio/frontend), cloned next to this repo as `../frontend`, and calls this API from its server, never from the browser.

## Requirements

- Bun 1.4.2 (`packageManager` in `package.json`).
- Local MongoDB 8.0 running as a replica set (transactions need one). With Homebrew:
  `brew install mongodb-community@8.0`, add `replication:` / `replSetName: rs0` to `/opt/homebrew/etc/mongod.conf`, `brew services start mongodb-community@8.0`, then once:
  `mongosh --eval 'rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:27017" }] })'`.

## Setup

Clone both repos side by side (default folder names, any parent folder):

```sh
mkdir brb-studio && cd brb-studio
git clone https://github.com/brb-studio/backend.git
git clone https://github.com/brb-studio/frontend.git
```

Then, in `backend/`:

```sh
cp .env.example .env
bun install
bun run dev        # http://localhost:4000/health
```

| Command | What it does |
|---|---|
| `bun run dev` / `bun run start` | Watch mode / plain start. Applies collection validators and indexes on boot |
| `bun run test` | Unit tests (`src/`, no database) |
| `bun run test:int` | Integration tests (`tests/`) against the local replica set, database `magicstudio_test` |
| `bun run lint` / `bun run format` | Biome check / fix |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run audit` | Fails on high/critical advisories |
| `bun run tenant:create --slug … --name … --plan trial\|basic\|pro\|lifetime --owner-email … --owner-name …` | Creates a tenant and its owner; prints the owner's generated password once |
| `bun run seed` | Two demo barbershops (`magicstudio`, `elite`) with staff and customer accounts, all with password `demo1234`; skips a tenant that already exists. `--reset` wipes first, only on `*_test` / `*_e2e` databases. Refuses production. Accounts and URLs: `../frontend/DEMO.md` |
| `bun run vapid:keys` | Prints a VAPID key pair for Web Push (`VAPID_*` in `.env`) |

## API

Every `/v1` request needs the tenant's host in `X-Forwarded-Host` (the frontend server forwards it): `<slug>.<PLATFORM_DOMAIN>` or the tenant's custom domain. Private routes also need `Authorization: Bearer <token>` from login/register. Errors are always `{ "error": { "code", "message", "issues"? } }`.

| Route | Who | Notes |
|---|---|---|
| `GET /v1/public/tenant` | anyone | Branding, theme and active branches |
| `POST /v1/auth/register` | anyone | Creates a customer account and returns `{ token, expiresAt, user }` |
| `POST /v1/auth/login` | anyone | 10 attempts per account per 15 min |
| `POST /v1/auth/logout` · `GET /v1/auth/me` | signed in | |
| `POST /v1/auth/password` | signed in | `{ currentPassword, newPassword }`; signs out every other session |
| `GET /v1/public/barbers?branch=&service=\|package=` | anyone | Active barbers of active branches; with `service`/`package` (slugs), only those who can do it |
| `GET /v1/public/catalog?branch=` | anyone | `{ currency, services, packages }` that at least one active barber (of that branch) can do |
| `GET /v1/tenant` · `PATCH /v1/tenant` | staff · owner/admin | PATCH: name, brand, theme |
| `GET /v1/branches` · `GET /v1/branches/:id` | staff | Managers and barbers only see their own branch |
| `POST /v1/branches` | owner/admin | 402 `PLAN_LIMIT` past the plan's active-branch limit |
| `PATCH /v1/branches/:id` | owner/admin/manager | Partial; `booking` merges; only owner/admin change `active` |
| `GET` · `POST /v1/users` · `PATCH /v1/users/:id` | owner/admin | Staff accounts. POST returns a one-time `temporaryPassword`. Only the owner grants `admin`; nobody edits the owner or changes their own role, branch or `active` |
| `GET /v1/barbers?branchId=` · `GET /v1/barbers/:id` | staff | Same branch visibility as branches |
| `POST /v1/barbers` · `PATCH /v1/barbers/:id` | owner/admin/manager | Hours default to the branch's; gaps between a day's intervals are breaks. `serviceIds`: services for every branch or for the barber's own. `userId` links a barber account of the same branch (`null` unlinks). 402 `PLAN_LIMIT` past the barber limit |
| `GET /v1/services` · `GET /v1/services/:id` | staff | Tenant-wide services plus those of the caller's branches |
| `POST /v1/services` · `PATCH /v1/services/:id` | owner/admin | `durationMin` 5–720, `priceMinor` integer minor units; no `branchId` = every branch (fixed after creation). Deactivate with `active: false`; nothing is deleted |
| `GET /v1/packages` · `GET /v1/packages/:id` | staff | Includes `durationMin` and `listPriceMinor` computed from the current services, and `servicesActive` |
| `POST /v1/packages` · `PATCH /v1/packages/:id` | owner/admin | Own `priceMinor`; `items` = 2–10 active services in order (repeats allowed) that fit the package's branch |
| `GET /v1/time-off?branchId=&barberId=` | staff | Entries that haven't ended. Barbers see their own plus branch closures |
| `POST /v1/time-off` · `DELETE /v1/time-off/:id` | staff | `{ barberId \| branchId, start, end, kind, reason? }` with `start`/`end` as local `YYYY-MM-DDTHH:MM` in the branch's timezone; `branchId` + `kind: "closure"` closes the whole branch. Barbers manage only their own |
| `GET /v1/public/availability?branch=&service=\|package=&barber=&from=&days=` | anyone | Free start times per barber and day (`from` local `YYYY-MM-DD`, `days` 1–31, capped by the branch's booking window and minimum notice) |
| `POST /v1/public/quote` | anyone | `{ branch, service\|package, code?, phone? }` → list price, discount and total; with `phone`, first-visit promotions are checked against that customer. 30 per IP per 10 min |
| `POST /v1/public/appointments` | anyone | `{ branch, barber, service\|package, startAt, customer?, code?, notes? }`. Signed-in customers book as themselves; guests send `customer: { name, phone, email? }` (matched by phone). 409 `SLOT_TAKEN`, `BARBER_UNAVAILABLE`, `PROMOTION_UNAVAILABLE`; 20 per IP and 5 per customer per hour |
| `GET /v1/me/appointments` · `POST /v1/me/appointments/:id/cancel` | customer | Own appointments; cancel until the branch's `cancelNoticeMin` (409 `TOO_LATE`) |
| `GET /v1/availability?branchId=&serviceId=\|packageId=&barberId=&from=&days=` | staff | Same engine, no booking window or notice limits (up to 365 days ahead) |
| `GET /v1/appointments?branchId=&barberId=&from=&to=` · `GET /v1/appointments/:id` | staff | Range at most 62 days. Barbers see their own, managers their branch |
| `POST /v1/appointments` | staff | Walk-ins and phone bookings: ids instead of slugs, `customerId` or `customer` |
| `PATCH /v1/appointments/:id` | staff | Either `status` (`completed`, `cancelled`, `no_show`) or a reschedule (`startAt`, `barberId`), plus `notes`. Only confirmed appointments change (409 `NOT_CONFIRMED`); `completed` / `no_show` only after it started |
| `GET /v1/promotions` · `GET /v1/promotions/:id` · `POST` · `PATCH /v1/promotions/:id` | staff · owner/admin | `percent` (1–100) or `fixed` (minor units); optional `code`, dates, branches, services/packages, `firstVisitOnly`, `maxRedemptions`. No code = applied automatically; the best discount wins |
| `GET /v1/notifications` · `POST /v1/notifications/read` | staff | Latest notifications of the caller; mark some or all as read |
| `GET /v1/notifications/stream` | staff | Server-Sent Events: `ready`, `notification`, `ping` every 15 s |
| `POST /v1/images` | owner/admin/manager | Raw bytes (JPEG, PNG or WebP, ≤ 1 MB; the type is read from the bytes, SVG refused) → `{ id }`. 500 per tenant, 60 per user per hour. Store `/api/images/<id>` (the frontend's path) in an `image` field |
| `GET /images/:id` | anyone | Outside `/v1` (no tenant): the photo, `Cache-Control: immutable`. Ids are 128-bit random |
| `GET /v1/billing` | owner | `price` (read from Stripe; `null` when subscriptions are off), plan, status, `creditMinor` (Stripe balance in favor), `referral: { code, friendPercent, rewardPercent, referred, rewarded, earnedMinor }`. `code` is `null` until the first paid month |
| `POST /v1/billing/referral-check` | owner | `{ code }` → `{ code, discountPercent }`. 404 `REFERRAL_NOT_FOUND`, 409 `REFERRAL_SELF` (own tenant or same owner email), 409 `REFERRAL_NOT_FIRST`; 20 per tenant per hour |
| `POST /v1/billing/checkout` | owner | `{ referralCode?, returnUrl }` → `{ url }` of Stripe Checkout for the one monthly price (`STRIPE_SUBSCRIPTION_PRICE`); paying sets plan `pro`. `returnUrl` must be the tenant's own site. 409 `ALREADY_SUBSCRIBED`, `LIFETIME_PLAN` |
| `POST /v1/billing/portal` | owner | `{ returnUrl }` → `{ url }` of Stripe's customer portal (card, invoices, cancel). 409 `NO_BILLING_ACCOUNT` |
| `GET /v1/notifications/push-key` · `POST` · `DELETE /v1/notifications/push-subscriptions` | staff | VAPID public key (404 `PUSH_DISABLED` without keys) and the browser's push subscription |

Writes return 402 `SUBSCRIPTION_INACTIVE` when the subscription is canceled or ended more than 7 days ago. Sessions last 30 days and renew once past half their life.

## Database safety

- Outside `NODE_ENV=production` the app refuses any MongoDB host other than `localhost`, `127.0.0.1` or `[::1]`.
- Under `bun test` it refuses any database whose name does not end in `_test` (`.env.test` sets `magicstudio_test`).
- Only `MONGO_DB` is touched. Other databases on the same server are never read or written.

## Decisions

- **Tenancy:** every business document carries `tenantId`. The tenant comes from the request host, and a session only works on its own tenant's host. Never from request input (bodies are strict: unknown keys are a 422). Features can only reach tenant data through `db/scoped.ts` (`forTenant()` adds `tenantId` to every query); Biome rejects importing the raw collections from `src/features`.
- **Accounts:** per tenant, so a customer of one barbershop has no account at another. Passwords hashed with argon2id (`Bun.password`). Sessions are 256-bit random tokens; only their SHA-256 is stored, and MongoDB's TTL index deletes expired ones.
- **Money:** integer minor units (`3500` = 35.00), stored as BSON int and enforced with `bsonType: "int"` validators. Currency is per tenant. This matches the frontend's `formatMoney(minor, currency)`. No floating point; Decimal128 adds nothing for 0–3 decimal currencies.
- **Double booking:** booking runs in a transaction that first bumps the barber's `lockVersion` (concurrent bookings for the same barber hit a WriteConflict and retry), then re-checks availability with the same engine as `GET /availability`. A partial unique index on `{ barberId, startAt }` is the database-level backstop.
- **Time:** instants are UTC `Date`. Business hours are local `"HH:MM"` in the branch's IANA timezone. Conversions use Bun's native `Temporal`.
- **Catalog:** a package stores only its own price and the ordered service ids. Its duration and list price are always computed from the current services. Who can do what is one pure rule (`catalog/rules.ts` → `offers`), shared by the catalog, the barber filter and booking.
- **Snapshots:** appointments embed name, duration and price of every service and package, plus the discount terms, at booking time. History never reads the live catalog.
- **Promotions:** pure rules (`promotions/rules.ts`), one `priceFor()` for quote and booking, so the price shown is the price charged. A redemption is a conditional `$inc` inside the booking transaction (`maxRedemptions` can't be exceeded); cancelling gives it back.
- **Notifications:** the barber's notification is written in the booking transaction (no booking without its notice). Live: one MongoDB change stream per process feeds every open SSE connection, so it works across instances with no broker. Phones: Web Push (RFC 8291 encryption + VAPID) with `node:crypto`, no package; sent after commit in chunks of 20; 404/410 from the push service deletes the subscription; only known push-service hosts are accepted (no SSRF).
- **Rate limits:** fixed windows in the `rateLimits` collection: one atomic upsert per attempt, so every API instance shares the count (30 concurrent attempts against a limit of 20 let exactly 20 through). Keys are SHA-256 hashed (no emails or phones stored); a TTL index drops old windows.
- **Visitor IP:** only the frontend's server may state it: it sends `X-Forwarded-For` plus `X-Proxy-Secret` (`PROXY_SECRET`, required in production). Without the secret the API uses the socket address, so a forged header can't dodge a limit. The frontend picks the IP its own proxies wrote (`TRUSTED_PROXY_HOPS`).
- **Performance:** the availability engine converts timezones once per window instead of per slot (30 barbers × 31 days in ~6 ms), so it stays on the main thread; no workers needed.
- **Subscriptions:** Stripe Billing on the platform account (the barbershop pays us), apart from Connect (`features/payments`, its customers pay the barbershop). Both arrive at `/webhooks/stripe`; billing ignores events carrying `account`. Webhooks re-read the subscription from the API (events arrive out of order) and copy plan, status, period end and limits onto the tenant, so `requireActiveSubscription` works unchanged. Billing routes skip that middleware: an expired barbershop must be able to pay.
- **Referrals:** a barbershop that has paid once gets an 8-symbol code (no I/O/0/1). Another barbershop using it on its first paid month gets 20% off that month (Stripe coupon, `duration: once`). Once that payment succeeds, the referrer gets 10% of the friend's list price as Stripe customer balance, which Stripe spends on the next invoices by itself and which stacks (10 friends = a free month; leftovers carry over). One referral per referee ever (unique index) and the credit carries an idempotency key, so a retried webhook can't pay twice. Rules in `billing/rules.ts`.
- **Business model:** one codebase. Subscription tenants plus one tenant on a `lifetime` plan. No per-customer forks.

## Layout

```
src/
  main.ts       Bun.serve + boot-time collection setup
  app.ts        Hono app: request id, errors, routes
  config.ts     environment, validated with Zod
  db/           client, collections (types, validators, indexes), scoped (tenant-safe access),
                notification-hub (one change stream → SSE), rate-limit (shared counter)
  features/     one folder per bounded context: routes.ts (HTTP only) → service.ts (rules + queries)
    auth/       accounts, sessions, roles (policy.ts), staff management (users.ts)
    tenancy/    tenant by host, branding, branches, plan limits (subscription.ts)
    barbers/    barber profiles, weekly hours, services they do, time off
    catalog/    services, packages, public catalog; rules.ts (pure: who can do what, totals)
    availability/ engine.ts (pure: free slots) + loading schedules
    booking/    appointments, customers, snapshots (order.ts), cancel, reschedule
    promotions/ rules.ts (pure) + pricing and redemptions
    notifications/ in-app notifications, SSE stream, Web Push subscriptions
    billing/    subscription checkout, portal, webhook sync; referral codes and rewards (rules.ts is pure)
  shared/       errors, validation, time (local ↔ instant with Temporal), web-push
scripts/        tenant-create.ts, seed.ts, vapid-keys.ts
tests/          integration tests (real MongoDB)
```

## Dependency policy

The same as the frontend: exact pins, versions younger than 3 days refused (`bunfig.toml`), no dependency lifecycle scripts (`trustedDependencies: []`), `bun.lock` committed, `bun audit` in CI. Before adding a package: can Bun, TypeScript or an installed package do it? Then the package must show its transitive dependencies, advisories, maintenance and scripts before it goes in.

## Specs (OpenSpec)

Business rules live as behavior specs in `openspec/specs/` (12 capabilities: tenancy, accounts-access, barbers-schedule, catalog, availability, booking, promotions, notifications, appointment-payments, subscription-billing, media, platform-safety), written from the code. `openspec list --specs` lists them, `openspec validate --specs --strict` checks them, and changes start with `/opsx:propose` in Claude Code. Update the spec in the same change as the code.
