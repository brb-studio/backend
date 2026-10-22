## Why
Las barberías premian la constancia ("el 10.º corte gratis") con tarjetas de sellos de papel que se pierden. Las promociones ya se aplican solas y ya se cuentan las visitas de cada cliente.

## What Changes
- Promociones con `everyVisits` (2–100): aplican en la visita N, 2N, 3N… del cliente, contando sus citas confirmadas y completadas más la que está reservando.
- `GET /v1/me/loyalty` (cliente): programas activos y cuántas visitas lleva en la vuelta actual.
- Frontend: campo "Lealtad: cada N visitas" en Promociones y una tarjeta de sellos en Cuenta.

## Decisions
- **Sin guardar sellos:** el avance sale de contar citas, igual que "primera visita"; cancelar la visita premiada libera el premio para la siguiente.
- **Usa todo el motor de promociones:** sucursales, servicios, fechas, tope por cliente, porcentaje o monto fijo (100 % = gratis) y "gana el mayor descuento".
- **No se combina con primera visita** (422).
- Una falta (`no_show`) no cuenta como visita; si el cliente falta a la visita premiada, la siguiente vuelve a ser la premiada.
- Boy-scout: promociones pasan de `src/db/collections.ts` a `src/db/promotions.ts`.

## Impact
- Specs: `promotions` (condición de lealtad, tarjeta de lealtad).
- Código: `src/db/promotions.ts`, `src/features/promotions/{rules,schemas,service,routes}.ts`, `src/app.ts`; pruebas `rules.test.ts`, `tests/counter.test.ts`.
