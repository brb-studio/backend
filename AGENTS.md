# AGENTS — Router obligatorio para IA (MagicStudio backend)

> Lee este archivo primero. Es la única puerta de entrada. El detalle vive en 3 pilares; no adivines nada que esté escrito ahí.

**Stack:** Bun 1.4 · Hono (core) · Zod 4 · MongoDB 7 (replica set `rs0`, transacciones) · Stripe (Billing + Connect) · TypeScript estricto (`noUncheckedIndexedAccess`, sin `any`).

## Orden de lectura obligatorio

1. `README.md` — setup, comandos, rutas API, decisiones de diseño.
2. `docs/ai/01-estructura.md` — dónde vive cada cosa y cómo fluye un request.
3. `docs/ai/02-logica-negocio.md` — reglas de negocio. Fuente de verdad: `openspec/specs/`.
4. `docs/ai/03-practicas-backend.md` — prohibiciones duras y patrones exigidos (cursor, tenancy, dinero, tiempo, errores).

Si vas a cambiar comportamiento de negocio: lee además el `spec.md` del capability afectado en `openspec/specs/<capability>/` **antes** de tocar código.

## Las 8 reglas que nunca se rompen

1. **Tenancy:** todo documento de negocio lleva `tenantId`. Solo se accede vía `forTenant()` en `src/db/scoped.ts`. Prohibido importar `db/client` o `db/collections` desde `src/features/` (Biome lo falla).
2. **Sin `aggregate`, sin `$lookup`.** Reportes y lecturas cruzadas: cursores planos + `for await` secuencial + suma en JS. Ver `docs/ai/03-practicas-backend.md`.
3. **Sin `toArray()` sobre result sets completos de documentos.** Usa `collect` / `mapBy` de `src/shared/cursor.ts` o `for await` directo con `.project()` mínimo.
4. **Dinero:** enteros en unidades menores (`priceMinor`, `totalMinor`), BSON `int`. Cero floats, cero Decimal128.
5. **Tiempo:** instantes UTC `Date`; horarios comerciales `"HH:MM"` locales en la zona IANA de la sucursal (Temporal). Nunca mezclar.
6. **HTTP delgado:** `routes.ts` solo HTTP → `service.ts` (reglas + queries) → `rules.ts` / `engine.ts` puras y testeadas sin DB.
7. **Contratos estables:** errores siempre `{ error: { code, message, issues? } }` con `code` en MAYÚSCULAS; bodies Zod estrictos (keys desconocidas = 422).
8. **Specs primero:** cambio de negocio = cambio de spec en el mismo PR. `openspec validate --specs --strict` debe pasar.

## Workflow exigido

- Cambios de negocio: `/opsx:propose` (o `openspec propose`) → implementar → actualizar `openspec/specs/*` en el mismo cambio → validar.
- Cross-tenant (`platform.*` de `src/db/scoped.ts`) solo en `src/features/platform/`. Nada fuera de ahí toca otra tenant.
- Archivos ≤500 líneas; deuda existente se paga poco a poco (boy-scout: deja cada archivo que toques más pequeño). Detalle en `docs/ai/03-practicas-backend.md` §8.
- Sin commits automáticos. Sin borrar archivos sin confirmar. Solo MongoDB local en dev (`localhost`/`127.0.0.1`/`::1`); tests solo en DB `*_test`.

## Verificación obligatoria antes de dar por terminado

```sh
bun run typecheck   # tsc --noEmit
bun run lint        # biome ci .
bun run test        # unitarias src/, sin DB
bun run test:int    # integración tests/, replica set local, DB magicstudio_test
```

`openspec validate --specs --strict` si tocaste `openspec/specs/`.
