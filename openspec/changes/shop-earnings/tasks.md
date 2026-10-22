## 1. Backend
- [x] 1.1 `revenue()` con cursores planos (citas completadas + apartados entregados) y suma en JS por día local.
- [x] 1.2 `GET /v1/earnings/summary` con rango validado (≤366 días).
- [x] 1.3 Prueba de integración en `tests/platform.test.ts`.

## 2. Frontend
- [x] 2.1 Sección "Ganancias" (owner/admin) y proxy `earnings/summary`.
- [x] 2.2 Periodos (`periods.ts` con prueba), tarjetas y gráfica por día.

## 3. Specs
- [x] 3.1 `platform-dashboard` actualizado; README.
- [x] 3.2 typecheck, biome, `bun run test`, `bun run test:int`.
