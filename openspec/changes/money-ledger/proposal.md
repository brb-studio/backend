## Why
Ganancias sumaba el valor de las citas completadas por el día de la cita y Caja sumaba cobros por la hora del cobro, con ventanas distintas: nunca coincidían. No había montos por reembolso, ni contracargos, ni pagos a barberos en ninguno de los dos. Propuesta completa: `../../../../propuesta-ganancias-caja.md`.

## What Changes (fase 1)
- Colección `ledgerEntries` (solo se agregan registros) con validador e índices `tenant_source_unique`, `tenant_day_at`, `tenant_branch_day`.
- Cada evento de dinero anota su registro en la misma transacción: mostrador (`booking/close.ts`), SPEI aceptada (`payments/service.ts`), Stripe pagado + comisión, reembolso y disputa (`payments/ledger.ts`), entrega de producto (`products/pickup.ts`), pago a barbero (`platform/payouts.ts`).
- `GET /v1/money/summary` y `GET /v1/money/movements` (owner, admin, manager).
- `scripts/migrate-ledger.ts`: reconstruye el libro con datos existentes, idempotente.

## Decisions
- `source` es la llave única por origen y evento (`counter:<cita>`, `payment:<pago>`, `fee:<pago>`, `refund:<pago>:<total reembolsado>`, `dispute:<du_…>`, `product:<pedido>`, `payout:<pago>`): la migración y los webhooks repetidos no duplican.
- `recordedBy` ausente = Stripe (en vez de guardar el texto "stripe").
- Los pagos a barberos no tienen método ni canal: el formulario de pagos no lo pide todavía.
- La comisión de Stripe es una salida aparte (`online_fee`) por el `applicationFeeMinor` completo. En un pago tardío reembolsado sin culpa de la barbería la plataforma absorbe esa comisión, pero el libro la deja como salida (diferencia de la comisión en ese caso raro).
- `/v1/cash` y `/v1/earnings/summary` no cambian en esta fase; se reescriben sobre el libro junto con sus pantallas (fases 2 y 3).

## Impact
- Specs: `platform-dashboard` (libro, resumen y movimientos), `appointment-payments` (reembolsos y disputas anotados).
- Código: `src/db/ledger.ts`, `src/features/money/`, los puntos de escritura de arriba; pruebas `src/features/money/rules.test.ts`, `tests/money.test.ts`, `tests/payments.test.ts`, `tests/stripe-refunds.test.ts`.
