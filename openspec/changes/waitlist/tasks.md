## 1. Backend
- [x] 1.1 Colección `waitlist` (tipo, validador, índices, TTL) y `forTenant`.
- [x] 1.2 `openSlots` en `availability/service.ts`.
- [x] 1.3 `waitlist/rules.ts` (ventana horaria) + pruebas unitarias.
- [x] 1.4 `waitlist/service.ts` (anotarse, listar, borrar) y `routes.ts` en `/v1/waitlist`.
- [x] 1.5 `waitlist/notify.ts` (avisador) y enganche en `runScheduled`.
- [x] 1.6 Pruebas de integración `tests/waitlist.test.ts`.

## 2. Frontend
- [x] 2.1 Formulario "Avísame si se libera" en la página del servicio.
- [x] 2.2 "Mi lista de espera" en la cuenta (ver y borrar).

## 3. Specs
- [x] 3.1 Nueva `openspec/specs/waitlist/spec.md`; `notifications` y `availability` actualizadas; README.
- [ ] 3.2 typecheck, biome, `bun run test`, `bun run test:int`.
