# brb-studio backend

API for brb-studio, a multi-tenant SaaS for barbershops. Bun · Hono · Zod · MongoDB. The frontend is [brb-studio/frontend](https://github.com/brb-studio/frontend), cloned next to this repo as `../frontend`, and calls this API from its server, never from the browser.

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
| `bun run test:int` | Integration tests (`tests/`) against the local replica set, database `brb-studio_test` |
| `bun run lint` / `bun run format` | Biome check / fix |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run audit` | Fails on high/critical advisories |
| `bun run tenant:create --slug … --name … --plan trial\|basic\|pro\|lifetime --owner-email … --owner-name …` | Creates a tenant and its owner; prints the owner's generated password once |
| `bun run seed` | Two demo barbershops (`magicstudio`, `elite`) with staff and customer accounts, all with password `demo1234`; skips a tenant that already exists. `--reset` wipes first, only on `*_test` / `*_e2e` databases. Refuses production. Accounts and URLs: `../frontend/DEMO.md` |
| `bun run platform-staff:create --email … --name …` | Creates a global platform staff account (outside any barbershop); prints its generated password once |
| `bun run vapid:keys` | Prints a VAPID key pair for Web Push (`VAPID_*` in `.env`) |

### Deploy (Vercel)

Vercel's Hono preset serves the default export of `src/app.ts` on the Bun runtime (`vercel.json`: `bunVersion`, beta). `src/main.ts` is only for running it yourself. Collections and indexes are ensured on each instance's first request.

1. Atlas: `mongodb+srv://…` URL (no `replicaSet=rs0`); Network Access must allow Vercel (dynamic IPs: `0.0.0.0/0` unless your plan has static IPs).
2. `vercel link`, then `vercel env add` for every variable in `.env.example` except `PORT` (`NODE_ENV` is set by Vercel). `PROXY_SECRET` is required.
3. `vercel deploy` (preview), check `GET /health`, then `vercel deploy --prod`.
4. Set `PAYMENT_TOKEN_SECRET` (32+ characters) and make sure `ownerProject` has an active document with your CLABE (`bankAccountKey`) and `name`: subscriptions are paid there.
5. Frontend: send the tenant host in `X-Tenant-Host` and the visitor IP in `X-Visitor-IP`. Vercel overwrites `X-Forwarded-Host`/`X-Forwarded-For`.

Limits on Hobby: 300 s per request (the notifications SSE stream is cut and the browser reconnects), 4.5 MB bodies, 1 h of logs.

## API

Every `/v1` request needs the tenant's host in `X-Tenant-Host` or `X-Forwarded-Host` (the frontend server forwards it; on Vercel only `X-Tenant-Host` survives): `<slug>.<PLATFORM_DOMAIN>` or the tenant's custom domain. Private routes also need `Authorization: Bearer <token>` from login/register. Errors are always `{ "error": { "code", "message", "issues"? } }`.

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
| `POST /v1/public/appointments` | anyone | `{ branch, barber, service\|package, startAt, customer?, code?, notes?, payment? }`. Signed-in customers book as themselves; guests send `customer: { name, phone, email? }` (a per-shop guest record keyed by phone; never matched to an account, since contact data is not verified). 409 `SLOT_TAKEN`, `BARBER_UNAVAILABLE`, `PROMOTION_UNAVAILABLE`; 20 per IP and 5 per customer per hour. With `payment: { kind: deposit\|full, method: card\|bank_transfer }` (shop with Stripe active) the appointment is `pending_payment`, holds the slot until `paymentDeadline` and the response has `checkout` (`clientSecret` for cards, Stripe's CLABE for transfers); 422 `PAYMENT_REQUIRED` when the shop asks for a deposit, 409 `ONLINE_PAYMENT_UNAVAILABLE`, `TRANSFER_TOO_LATE`, 502 `PAYMENT_PROVIDER_ERROR` |
| `GET /v1/me/appointments` · `POST /v1/me/appointments/:id/cancel` | customer | Own appointments; cancel until the branch's `cancelNoticeMin` (409 `TOO_LATE`) |
| `GET /v1/availability?branchId=&serviceId=\|packageId=&barberId=&from=&days=` | staff | Same engine, no booking window or notice limits (up to 365 days ahead) |
| `GET /v1/appointments?branchId=&barberId=&from=&to=` · `GET /v1/appointments/:id` | staff | Range at most 62 days. Barbers see their own, managers their branch |
| `GET /v1/appointments/my-day` | staff | The caller's own confirmed/completed cuts for today on their branch's clock (any role linked to a barber profile); `{ "barber": null }` if not linked |
| `POST /v1/appointments` | staff | Walk-ins and phone bookings: ids instead of slugs, `customerId` or `customer` |
| `PATCH /v1/appointments/:id` | staff | Either `status` (`completed`, `cancelled`, `no_show`) or a reschedule (`startAt`, `barberId`), plus `notes`. Only confirmed appointments change (409 `NOT_CONFIRMED`); `completed` / `no_show` only after it started |
| `GET /v1/promotions` · `GET /v1/promotions/:id` · `POST` · `PATCH /v1/promotions/:id` | staff · owner/admin | `percent` (1–100) or `fixed` (minor units); optional `code`, dates, branches, services/packages, `firstVisitOnly`, `maxRedemptions`. No code = applied automatically; the best discount wins |
| `GET /v1/notifications` · `POST /v1/notifications/read` | any account | Latest notifications of the caller; mark some or all as read |
| `GET /cron/digest` | cron (`CRON_SECRET`) | Sends the morning summary push (today's appointments and SPEI transfers to confirm) to owners/admins; 404 without the secret. A long-running server also runs it every 10 min on its own |
| `GET /v1/notifications/stream` | any account | Server-Sent Events: `ready`, `notification`, `ping` every 15 s |
| `POST /v1/images` | owner/admin/manager | Raw bytes (JPEG, PNG or WebP, ≤ 1 MB; the type is read from the bytes, SVG refused) → `{ id }`. 500 per tenant, 60 per user per hour. Store `/api/images/<id>` (the frontend's path) in an `image` field |
| `GET /images/:id` | anyone | Outside `/v1` (no tenant): the photo, `Cache-Control: immutable`. Ids are 128-bit random |
| `POST /v1/public/payments/transfer` | anyone (guest: `paymentToken`; customer: own appointments) | `{ appointmentId, paymentToken? }` → the pending transfer `{ id, amountMinor, currency, holder, clabe, expiresAt }`. 409 `TRANSFER_NOT_AVAILABLE` / `ALREADY_PAID`, 422 `NOTHING_TO_CHARGE`, 429 |
| `GET /v1/public/appointments/:id/payment?paymentToken=&secret=` · `POST /v1/public/appointments/:id/payment` | anyone (guest: `paymentToken`; customer: own appointments) | Online payment state (kind, method, amount, balance, deadline, card brand/last 4, transfer instructions; `secret=1` returns the card `clientSecret` again). POST `{ kind, method, paymentToken? }` switches card ↔ transfer or deposit ↔ full while `pending_payment` (same deadline); 409 `NOT_PENDING_PAYMENT`, `ALREADY_PAID`, `TRANSFER_TOO_LATE` |
| `GET`·`PATCH /v1/payments/settings` | owner/admin | Bank account for transfers: `{ bankTransferEnabled, bankAccountKey (CLABE), bankAccountHolder }` |
| `GET /v1/payments/stripe` · `POST /v1/payments/stripe/onboarding` · `POST /v1/payments/stripe/refresh` · `POST /v1/payments/stripe/dashboard` | owner/admin | Stripe Connect: status (`none`, `onboarding`, `pending`, `active`, `restricted`) and `requirementsDue`, never Stripe ids. Onboarding `{ locale? }` creates the connected account once and returns a fresh hosted-onboarding `url`; refresh rereads the account from Stripe; dashboard returns an Express login `url` (409 `ONBOARDING_INCOMPLETE`). 503 `ONLINE_PAYMENTS_DISABLED` without Stripe keys |
| `PATCH /v1/payments/deposit` | owner/admin | `{ enabled, percentBps: 100–10000 }`: with it on, online bookings must pay at least that share (rounded up to the peso) |
| `POST /v1/payments/appointments/:id/refund` | owner/admin | `{ amountMinor? }` (default: what is left) refunds an online payment through Stripe and takes exactly that back from the shop's transfer; what the transfer can't cover (the fee the platform kept) becomes the shop's `feeDebtMinor`, collected on top of the fee of its next payments. 422 `REFUND_TOO_LARGE`, 409 `NOT_REFUNDABLE`. Customers cancelling in time get back what they paid minus Stripe's fee (`refundableMinor` on the checkout and the appointment) |
| `POST /webhooks/stripe` | Stripe | Outside `/v1` (no tenant host). `Stripe-Signature` checked on the raw body against `STRIPE_WEBHOOK_SECRET` (400 `BAD_SIGNATURE`); events deduplicated by id. Handles `payment_intent.*`, `charge.refunded`, `charge.dispute.created`, `account.updated` and Accounts v2 thin events `v2.core.account*` |
| `GET /v1/payments?status=` · `POST /v1/payments/:id/confirm` · `POST /v1/payments/:id/reject` | owner/admin | List transfers; confirm `{ receivedMinor, reference? }` (422 `AMOUNT_MISMATCH`) or reject `{ reason? }`. 409 `INVALID_TRANSITION` if not pending |
| `GET /v1/billing` | owner | `price` (`SUBSCRIPTION_PRICE_MINOR`, monthly), plan, status, `currentPeriodEnd`, `subscribed`, `creditMinor` (referral credit), `pending` (the transfer waiting to be confirmed, with CLABE and holder), `referral: { code, friendPercent, rewardPercent, referred, rewarded, earnedMinor }`, `referredBy?` |
| `POST /v1/billing/referral-check` | owner | `{ code }` → `{ code, discountPercent }`. 404 `REFERRAL_NOT_FOUND`, 409 `REFERRAL_SELF` (own tenant or same owner email), 409 `REFERRAL_NOT_FIRST`; 20 per tenant per hour |
| `POST /v1/billing/payment` | owner | `{ referralCode? }` → the pending SPEI transfer for one month (amount = list price − referral discount − credit, computed by the API; same payment while pending). 409 `LIFETIME_PLAN`, 503 `BILLING_DISABLED` (no valid account in `ownerProject`), 429 |
| `GET /platform/subscriptions?status=` · `POST /platform/subscriptions/:id/confirm` · `…/reject` | platform staff | Queue of subscription transfers; confirm `{ receivedMinor, reference? }` activates plan `pro` for a month (422 `AMOUNT_MISMATCH`, 409 `INVALID_TRANSITION`) |
| `POST /platform/auth/login` · `GET /platform/auth/me` · `POST /platform/auth/logout` | platform staff | Outside `/v1`: no tenant host. Own accounts (`platformStaff`) and 12 h sessions (`platformSessions`); tenant tokens don't work here and vice versa. 10 attempts per account and 30 per IP per 15 min |
| `GET /platform/summary?from=&to=&tenantId=&branchId=&barberId=&status=` | platform staff | Totals per currency: `sales`, `collected`, `commission`, `paidOut`, `pending`, `avgTicket`, counts by status, `unconfigured` (completed cuts with no commission rate). `from`/`to` are local dates (each appointment's own branch time zone), at most 366 days apart |
| `GET /platform/breakdown?by=tenant\|branch\|barber&…&page=&limit=` | platform staff | Every tenant/branch/barber in scope with its numbers (zeros included), ranked by sales. With `from=to=<day>` it is the day's earnings per barber |
| `GET /platform/appointments?…&page=&limit=` · `GET /platform/appointments/:id` | platform staff | The cuts (newest first, ≤100 per page) with payment, commission and payout; the detail adds customer, items, discount and how the commission was worked out |
| `GET /platform/options?tenantId=&branchId=` | platform staff | Names for the filters |
| `PATCH /platform/barbers/:id/commission` | platform staff | `{ commissionBps: 0–10000 \| null }`; `null` removes the rate |
| `POST /platform/payouts` | platform staff | `{ barberId, appointmentIds, reference?, paidAt? }` settles completed cuts; the amount is the sum of their commissions. 409 `COMMISSION_NOT_CONFIGURED`, `INVALID_APPOINTMENTS`, `ALREADY_PAID` |
| `GET /v1/notifications/push-key` · `POST` · `DELETE /v1/notifications/push-subscriptions` | any account | VAPID public key (404 `PUSH_DISABLED` without keys) and the browser's push subscription |

Writes return 402 `SUBSCRIPTION_INACTIVE` when the subscription is canceled or ended more than 7 days ago. Sessions last 30 days and renew once past half their life.

## Database safety

- Outside `NODE_ENV=production` the app refuses any MongoDB host other than `localhost`, `127.0.0.1` or `[::1]`.
- Under `bun test` it refuses any database whose name does not end in `_test` (`.env.test` sets `brb-studio_test`).
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
- **Notifications:** the barber's notification (and the customer's, when staff or the payment provider change their visit; never for guests or for their own actions) is written in the booking transaction (no booking without its notice). Live: one MongoDB change stream per process feeds every open SSE connection, so it works across instances with no broker. Phones: Web Push (RFC 8291 encryption + VAPID) with `node:crypto`, no package; sent after commit in chunks of 20; 404/410 from the push service deletes the subscription; only known push-service hosts are accepted (no SSRF).
- **Rate limits:** fixed windows in the `rateLimits` collection: one atomic upsert per attempt, so every API instance shares the count (30 concurrent attempts against a limit of 20 let exactly 20 through). Keys are SHA-256 hashed (no emails or phones stored); a TTL index drops old windows.
- **Visitor IP:** only the frontend's server may state it: it sends `X-Visitor-IP` (or `X-Forwarded-For`, which Vercel overwrites) plus `X-Proxy-Secret` (`PROXY_SECRET`, required in production). Without the secret the API uses the socket address, so a forged header can't dodge a limit. The frontend picks the IP its own proxies wrote (`TRUSTED_PROXY_HOPS`).
- **Performance:** the availability engine converts timezones once per window instead of per slot (30 barbers × 31 days in ~6 ms), so it stays on the main thread; no workers needed.
- **Subscriptions:** paid by SPEI transfer to the CLABE in the active `ownerProject` document; no Stripe. The owner asks (`POST /v1/billing/payment`), a `subscriptionPayments` document is created `pending` (5 days) with the account copied in, and platform staff confirm it by hand once the money shows in the bank. Confirming sets plan `pro`, adds a month to what was left (`currentPeriodEnd`), spends referral credit and rewards the referrer, all in one transaction. A lapsed period locks writes after the 7-day grace (`requireActiveSubscription`). Old Stripe ids on tenants are kept untouched.
- **Appointment payments:** two ways, both in `features/payments`. **Online (Stripe Connect):** each barbershop is a connected account (Accounts v2, `recipient` configuration, Express dashboard, fees and losses on the platform) onboarded through Stripe's hosted form; the platform creates *destination charges* (`transfer_data.destination`) so the shop gets the charge minus an `application_fee_amount` that covers Stripe's fee plus IVA (`payments/rules.ts`, configurable), and the platform never holds the money. Card payments use the Payment Element (card data never touches this API); bank transfers use Stripe's `customer_balance` with `mx_bank_transfer` (a CLABE per Stripe Customer). Mexican bank transfers with `on_behalf_of` are refused by Stripe by default, one reason for destination charges. A booking that pays online is `pending_payment` and holds its slot until `paymentDeadline` (20 min card, 60 min transfer); only the webhook confirms it, after rereading the PaymentIntent and checking amount, currency and destination against the database. Expired holds are cancelled before every booking and when the customer reads their appointments or payment; money arriving late is refunded in full. Stripe calls use `fetch` (no SDK, per the dependency policy). **Currencies:** shops in MXN take cards, Link and Mexican bank transfers; shops in USD take cards and Link only (SPEI is pesos only, 409 `METHOD_UNAVAILABLE`). Stripe Mexico can't settle in USD (multi-currency settlement isn't available in MX), so dollar charges are converted to pesos (+2%) and the shop receives MXN at its CLABE. The fee kept is estimated per currency: pesos as a domestic card (3.6% + MXN 3.00), dollars as a foreign card plus conversion (3.6% + 0.5% + 2% + USD 0.20, `STRIPE_CARD_FEE_FIXED_MINOR_USD`), plus IVA. Minimums: MXN 10.00, USD 0.50; deposits round up to the whole peso or dollar. A shop's fee debt keeps its currency (`feeDebtCurrency`). **Manual step for Apple Pay / Google Pay:** in production, register every domain that shows the payment form (each barbershop subdomain and custom domain) in the platform's Stripe Dashboard → Settings → Payment method domains (one registration per domain, on the platform account; destination charges don't need it on connected accounts). Without it the Payment Element just hides those wallets; they can't be tested on `localhost`. **Manual (fallback):** SPEI bank transfers straight to the barbershop's own CLABE; the app never touches the money. A customer asks for the bank details (`POST /v1/public/payments/transfer`), a `payments` document is created `pending` with a frozen copy of the account, and owner/admin confirm or reject it by hand once it shows in their bank (`pending → paid | rejected | expired`, 48 h, history kept). Amount and account always come from the database. Legacy Stripe payments on old appointments (no `paymentId`) are kept as they were. Guests prove their booking with `paymentToken` (HMAC with `PAYMENT_TOKEN_SECRET`, required in production). Billing routes skip `requireActiveSubscription`: an expired barbershop must be able to pay.
- **Referrals:** a barbershop that has paid once gets an 8-symbol code (no I/O/0/1). Another barbershop using it on its first paid month gets 20% off that month. Once that payment succeeds, the referrer gets 10% of the friend's list price as `billing.creditMinor`, taken off their next payments and stacking (10 friends = a free month; leftovers carry over). One referral per referee ever (unique index) and the credit carries an idempotency key, so a retried webhook can't pay twice. Rules in `billing/rules.ts`.
- **Platform dashboard:** `features/platform` serves the global staff (`/platform/*`, outside `/v1`). Platform staff are not tenant users: separate collections, separate sessions, created only with `bun run platform-staff:create`. Their cross-tenant reads go through `platform.*` in `db/scoped.ts`. Money is never added across currencies (one total per currency). Four figures stay apart: **sales** (completed cuts' `totalMinor`), **collected** (Stripe `payment.status = paid`), **commission earned** and **payouts made**. Commission = `totalMinor × commissionBps / 10000`, rounded half up (`platform/commission.ts`, the only place the rule lives). Reports read with plain cursors and sum in JS (no `aggregate`, no `$lookup`: measured on 400k appointments, a year of one barbershop went from 680 ms to 87 ms and a year of all of them from 13 s to 1.6 s); a paid appointment carries `payoutId`, so "paid" needs no join. There is no default rate: `barbers.commissionBps` unset means "not configured", reported as such and never paid. The rate is frozen on the appointment (`commission: { bps, amountMinor }`) when it is completed or when its commission is paid, so later rate changes can't rewrite history. A payout settles whole appointments; the unique index on `payouts.appointmentIds` makes paying one twice impossible, even concurrently.
- **Indexes (appointments):** `barber_start_live_unique` (double-booking guard + availability), `tenant_branch_start` (agenda, branch reports; measured: also serves tenant-wide ranges with keys ≈ docs, so no `{tenantId,startAt}`), `barber_start` (one barber's agenda/earnings: 346 → 20 keys examined, +14 B/appointment), `tenant_customer_start`, `payment_intent`, `start` (cross-tenant platform reports; without it a COLLSCAN). `users.tenant_role` keeps the staff list from scanning every customer account.
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
    booking/    appointments, guest customers (customers.ts), snapshots (order.ts), cancel, reschedule
    promotions/ rules.ts (pure) + pricing and redemptions
    notifications/ in-app notifications, SSE stream, Web Push subscriptions
    platform/   global staff dashboard: auth, aggregations, commission (pure), payouts
    billing/    subscription transfers (SPEI to ownerProject), referral codes and rewards (rules.ts is pure)
    payments/   Stripe Connect (connect, checkout, holds, ledger, settle, webhook, stripe/ fetch client) and manual SPEI; rules.ts is pure
  shared/       errors, validation, time (local ↔ instant with Temporal), web-push
scripts/        tenant-create.ts, seed.ts, vapid-keys.ts
tests/          integration tests (real MongoDB)
```

## Dependency policy

The same as the frontend: exact pins, versions younger than 3 days refused (`bunfig.toml`), no dependency lifecycle scripts (`trustedDependencies: []`), `bun.lock` committed, `bun audit` in CI. Before adding a package: can Bun, TypeScript or an installed package do it? Then the package must show its transitive dependencies, advisories, maintenance and scripts before it goes in.

## Specs (OpenSpec)

Business rules live as behavior specs in `openspec/specs/` (13 capabilities: platform-dashboard, tenancy, accounts-access, barbers-schedule, catalog, availability, booking, promotions, notifications, appointment-payments, subscription-billing, media, platform-safety), written from the code. `openspec list --specs` lists them, `openspec validate --specs --strict` checks them, and changes start with `/opsx:propose` in Claude Code. Update the spec in the same change as the code.

## Identity model: users, guests, no `customers`

`users` is the only identity collection and is per barbershop: a person with N shops has N independent
accounts (same or different email/password), and nothing links them because emails are not verified.
Customers who book without signing up are `guest: true` records (no `email`/`passwordHash`, `contactEmail`
for the address they typed, unique per `tenantId+phone`) that can't sign in. `appointments.customerId`
is always a `users._id` of the same tenant. Signing up never claims a guest by phone.

Existing data: `bun scripts/migrate-customers.ts` (dry run) / `--apply` folds the legacy `customers`
collection into `users` (idempotent, deletes nothing; `customers` stays as backup until you drop it).

## Verificación de correo y recuperación de contraseña

`POST /v1/auth/verify-email` · `verify-email/request` · `password/forgot` · `password/reset` (ver
`openspec/specs/accounts-access`). Los enlaces apuntan a `/{lang}/verify-email` y `/{lang}/reset-password` del
frontend de la barbería. Correo vía Resend (`RESEND_API_KEY` + `MAIL_FROM`); sin configurar, en desarrollo el
correo se imprime en la consola del backend.
