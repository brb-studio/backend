# 01 — Estructura del proyecto (para IA)

> Dónde vive cada cosa y cómo fluye un request. Si no está aquí, no lo inventes: busca con `glob`/`grep`.

## Layout canónico

```
src/
  main.ts       Bun.serve + setup de colecciones (validadores + índices) en boot
  app.ts        Hono app: requestId, headers seguridad, log, montaje de rutas
  config.ts     Env validado con Zod
  db/
    client.ts       Conexión MongoDB + guardas de seguridad (solo localhost fuera de prod, solo *_test bajo bun test)
    collections.ts  Tipos, validadores BSON, índices. Fuente de esquema.
    scoped.ts       ÚNICA puerta de acceso: forTenant(tenantId) + platform.* + transaction()/runAll()
    setup.ts        Aplica validadores e índices en boot
    notification-hub.ts  Un change stream por proceso → SSE
    rate-limit.ts   Contador compartido (upsert atómico)
  features/     Un directorio por contexto acotado:
    routes.ts   SOLO HTTP (parse Zod, auth, llama a service). Sin queries directas ni reglas.
    service.ts  Reglas + queries (usa forTenant, cursores, transacciones).
    rules.ts / engine.ts / commission.ts  Lógica PURA, sin DB, con .test.ts al lado.
    schemas.ts  Contratos Zod estrictos.
    policy.ts / subscription.ts / order.ts / customers.ts  Sub-piezas del contexto.
  shared/
    http.ts     Env, AppError, onError/notFound (formato error estable)
    cursor.ts   collect() / mapBy() — la forma aprobada de consumir cursores
    time.ts     Conversiones UTC ↔ local con Temporal
    rate-limit.ts / web-push.ts / photos.ts
scripts/        tenant-create.ts, seed.ts, platform-staff-create.ts, vapid-keys.ts
tests/          Integración con MongoDB real (helpers.ts, env.ts, preload.ts, *.test.ts)
openspec/specs/ 13 capabilities, cada una con spec.md. Fuente de verdad de negocio.
docs/ai/        Esta documentación de hardening (01, 02, 03).
```

## Flujo de un request

```
Hono (app.ts) → resolveTenant + authenticate (/v1/*)
  → routes.ts: valida body/query (Zod strict) → service.ts
    → scoped.forTenant(tenantId) → MongoDB (cursor / insert / update / tx)
    → rules.ts/engine.ts puras para decidir
  → respuesta JSON o AppError(code MAYÚSCULAS)
```

- `/platform/*` está **fuera** de `/v1`: sin tenant por host, con su propio auth (`features/platform/auth.ts`, sesiones `platformSessions`). Es el único lugar que puede usar `platform.*`.
- `GET /images/:id` está fuera de `/v1` (sin tenant, IDs aleatorios 128-bit, `Cache-Control: immutable`).

## Mapa `features/` → dominio

| Carpeta | Responsabilidad | Piezas puras |
|---|---|---|
| `auth/` | cuentas por tenant, sesiones, roles, staff (`users.ts`, `policy.ts`) | `policy.ts` |
| `tenancy/` | tenant por host, branding, branches, límites de plan (`subscription.ts`) | `subscription.ts` |
| `barbers/` | perfiles barbero, horario semanal, servicios que hace, `time-off.ts` | — (validación en schemas/service) |
| `catalog/` | servicios, paquetes, catálogo público | `rules.ts` (`offers`: quién puede hacer qué) |
| `availability/` | slots libres | `engine.ts` (pura, convierte zona 1 vez por ventana) |
| `booking/` | citas, clientes, snapshots (`order.ts`), cancel/reschedule | `order.ts` |
| `promotions/` | promos + pricing + redenciones | `rules.ts` (`priceFor`: lo cotizado = lo cobrado) |
| `notifications/` | notificaciones in-app, SSE, push subscriptions | — |
| `platform/` | dashboard staff global: auth, reportes, comisión, payouts | `commission.ts` (`resolveCommission`, único lugar de la regla) |
| `billing/` | suscripción por transferencia SPEI a `ownerProject`, referidos | `rules.ts` |
| `payments/` | Transferencias SPEI directas a la CLABE de la barbería, confirmación manual | `service.ts`, `clabe.ts`, `token.ts` |
| `images/` | upload JPEG/PNG/WebP ≤1MB, tipo leído de los bytes | — |

## Base de datos (`db/`)

- Todo documento de negocio lleva `tenantId: ObjectId`.
- `scoped.ts:66` — `forTenant(tenantId)` inyecta `tenantId` en **cada** query (`find`, `findOne`, `insertOne`, `updateOne/Many`, `findOneAndUpdate`, `deleteOne`, `countDocuments`).
- `scoped.ts:83` — `platform.*` expone colecciones crudas para lecturas cross-tenant. **Solo `features/platform/` lo usa.**
- `scoped.ts:99-115` — `runAll()` (paralelo sin sesión, secuencial con sesión) y `transaction()` (`snapshot` + `majority`).
- `collections.ts` — validadores (`bsonType: "int"` para dinero) e índices. Índices clave de `appointments`: `barber_start_confirmed_unique` (anti-doble-reserva), `tenant_branch_start`, `barber_start`, `tenant_customer_start`, `payment_intent`, `start`.

## Reglas de navegación para IA

1. Nuevo endpoint → toca `routes.ts` (HTTP) + `service.ts` (lógica). Si hay decisión de negocio reutilizable, extráela a `rules.ts`/`engine.ts` con su `.test.ts`.
2. Nueva query multi-documento → cursor plano + `for await` + `.project()` mínimo. Nunca `aggregate`/`$lookup` (ver `03-practicas-backend.md`).
3. Nuevo campo de negocio → actualiza `collections.ts` (tipo + validador + índice si filtra/ordena) **y** el `spec.md` del capability.
4. Cross-tenant → solo en `features/platform/`. Si estás fuera de ahí y crees necesitarlo, detente y pregunta.
5. Tests: lógica pura → `src/**/*.test.ts` (`bun run test`, sin DB). Flujo con DB → `tests/*.test.ts` (`bun run test:int`).
