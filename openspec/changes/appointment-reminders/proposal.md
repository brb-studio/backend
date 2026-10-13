## Why
El "no-show" es la mayor pérdida de una barbería y hoy el cliente no recibe ningún aviso antes de su cita. Ya existen push, correo (Resend) y un temporizador cada 10 minutos (resumen diario), así que el recordatorio reutiliza esa infraestructura.

## What Changes
- Recordatorio al cliente **24 h** y **2 h** antes de su cita, por push (cuenta con teléfono registrado) y por correo (`email` de la cuenta o `contactEmail` del invitado).
- Cada barbería puede apagarlos (`reminders.enabled`, encendido por defecto) desde Ajustes.
- El temporizador del servidor y `GET /cron/tick` (alias `GET /cron/digest`) ejecutan resumen diario y recordatorios.
- Nuevo aviso `customer.reminder` en la bandeja del cliente.

## Decisions
- **Sin campos nuevos en la cita.** Cada recordatorio se "reclama" con el contador atómico compartido (`hit`) bajo la clave `(cita, startAt, 24h|2h)`. Reprogramar cambia `startAt` y por eso arma recordatorios nuevos solos.
- **Un solo recordatorio por tick y por cita:** el más cercano a la cita. Si el temporizador estuvo caído y ya pasó el de 24 h, solo sale el de 2 h.
- **No se recuerda lo que se acaba de reservar:** el recordatorio solo sale si la cita se creó antes del momento del recordatorio.
- Sin WhatsApp ni SMS (cuestan dinero); un invitado sin correo no tiene canal.
- Índice nuevo `{ tenantId, startAt }` para barrer solo las próximas 24 h de una barbería.

## Impact
- Specs: `notifications`, `tenancy`.
- Código: `src/features/notifications/reminders.ts` (+ reglas puras), `src/features/platform/{digest,cron}.ts`, `src/main.ts`, `src/features/tenancy`, `src/db/collections.ts`. Frontend: Ajustes.
