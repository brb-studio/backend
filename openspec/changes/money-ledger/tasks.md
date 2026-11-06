## 1. Libro (fase 1)
- [x] 1.1 Colección `ledgerEntries` con validador e índices.
- [x] 1.2 Escritura en mostrador, SPEI, Stripe (pago, comisión, reembolso, disputa), productos y pagos a barberos.
- [x] 1.3 `GET /v1/money/summary` y `GET /v1/money/movements`.
- [x] 1.4 Migración idempotente: corre sola una vez tras el deploy (`oneTimeJobs`, `src/db/ledger-backfill.ts`) o a mano con `scripts/migrate-ledger.ts`.
- [x] 1.5 Pruebas: reglas puras, cada escritura, migración y suma de días = rango.

## 2. Caja en la web (fase 2)
- [x] 2.1 `GET /v1/cash` reescrito sobre el libro, con "por cobrar" informativo; conserva los campos que usa la app móvil.
- [x] 2.2 Pantalla de Caja (línea del día, detalle de cada movimiento, colores fijos de dinero).

## 3. Ganancias en la web (fase 3)
- [x] 3.1 Pantalla con rango personalizado, gráfica, desglose y movimientos; exportar CSV.
- [ ] 3.2 Quitar `platform/revenue.ts` y `GET /v1/earnings/summary` (lo usa la app móvil: se quita en la fase 5).

## 4. Gastos, ajustes y devoluciones SPEI (fase 4)
- [x] 4.1 `POST /v1/money/entries` (owner, admin) con `reverses` y nota obligatoria en ajustes.
- [x] 4.2 Devolución de SPEI (mismo endpoint de reembolso de la cita).
- [x] 4.3 Caja: registrar gasto, ajuste, revertir y devolver desde el detalle.

## 5. App móvil (fase 5)
- [x] 5.1 Caja y Ganancias en `mobile/` sobre el libro (gastos, ajustes, revertir, devolver, rango en hoja).
- [ ] 5.2 Quitar de `GET /v1/cash` los campos viejos (`totals`, `people`, `movements`, `unrecorded`) y `GET /v1/earnings/summary` + `platform/revenue.ts`, cuando ya no haya builds de la app anteriores a 5.1 en uso.
