## 1. Backend
- [x] 1.1 `profileSchema` con el mismo nombre y teléfono del registro.
- [x] 1.2 `updateProfile()`: Stripe primero, luego `$set`/`$unset` en `users`.
- [x] 1.3 `PATCH /v1/auth/me` solo para clientes.
- [x] 1.4 Pruebas de integración en `tests/customers.test.ts`.

## 2. Frontend
- [x] 2.1 "Mis datos" en Cuenta (solo clientes) con nombre y teléfono.

## 3. Specs
- [x] 3.1 `accounts-access` actualizado; README.
- [x] 3.2 typecheck, biome, `bun run test`, `bun run test:int`.
