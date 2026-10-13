## 1. Backend
- [x] 1.1 `customer.reminder` en `NOTIFICATION_TYPES` y títulos es/en; `reminders?: { enabled }` en `TenantDoc` (+ validador) y en `tenantUpdate`/`toTenant`.
- [x] 1.2 Índice `tenant_start` en `appointments`.
- [x] 1.3 `notifications/reminder-rules.ts` (puro) + pruebas unitarias.
- [x] 1.4 `notifications/reminders.ts` (`sendReminders`): barrido, reclamo, push y correo.
- [x] 1.5 `platform/digest.ts` → `runScheduled`; `GET /cron/tick` y alias `/cron/digest`; `main.ts`.
- [x] 1.6 Prueba de integración `tests/reminders.test.ts`.

## 2. Frontend
- [x] 2.1 Interruptor de recordatorios en Ajustes (es/en).

## 3. Specs y documentación
- [x] 3.1 `notifications` y `tenancy` actualizadas; README/docs si mencionan `/cron/digest`.
- [x] 3.2 typecheck, biome, `bun run test`, `bun run test:int`.
