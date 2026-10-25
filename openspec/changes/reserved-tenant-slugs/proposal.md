## Why
El sitio de marketing vive en el dominio raíz y en `www`; otros subdominios (`app`, `api`, `status`, `docs`…) quedan para la plataforma. Si una barbería tomara uno de esos slugs, su subdominio chocaría con ellos.

## What Changes
- `tenantSlug` en `src/features/tenancy/schemas.ts`: el `slug` de siempre más el rechazo de `www`, `app`, `api`, `admin`, `platform`, `site`, `mail`, `status`, `docs`, `help`, `blog` ("this slug is reserved"; en HTTP, 422 `VALIDATION`).
- `tenantQuery()` nunca resuelve un host `<reservado>.<PLATFORM_DOMAIN>` a una barbería.

## Decisions
- **Solo para barberías:** sucursales, servicios y barberos siguen con `slug`, porque viven en rutas, no en subdominios.
- **El alta es por script** (`scripts/tenant-create.ts`); no hay endpoint HTTP de alta. El script debe validar con `tenantSlug` en lugar de `slug` (cambio de una línea, pendiente porque `scripts/` lo edita otro frente).

## Impact
- Specs: `tenancy` (requisito "Slugs de barbería reservados").
- Código: `src/features/tenancy/schemas.ts`, `service.ts` y sus pruebas; `scripts/tenant-create.ts` (pendiente).
