## Why
El staff ya puede mover una cita con `PATCH /v1/appointments/:id` (`startAt`, `barberId`), pero no tiene de dónde sacar los horarios libres para esa cita. La disponibilidad del staff (`GET /v1/availability`) calcula con la duración actual del catálogo y cuenta la propia cita como ocupada, así que su hora y las que se le enciman salen tomadas. Por eso el panel web y la app no tienen botón "Reprogramar" en la Agenda.

## What Changes
- Nuevo `GET /v1/appointments/:id/slots?from=&days=&barberId=` para el staff: horarios libres para mover esa cita, con la misma forma que la disponibilidad del staff.
- Usa la duración y los servicios guardados en la cita, ofrece solo barberos activos de su sucursal que hacen esos servicios y no cuenta la propia cita como ocupada.
- Mismo alcance que la agenda: el manager solo citas de su sucursal; el barbero solo las suyas y solo consigo mismo.
- Nueva capability: no. Se amplía `booking`.

## Decisions
- **Mismos límites que reprogramar por el staff.** Ventana de 365 días y sin aviso mínimo, como `bookAsStaff` y el `PATCH`, que es quien revalida al guardar.
- **Archivo propio.** `src/features/booking/staff-slots.ts`: `service.ts` ya pasa de 500 líneas.

## Impact
- Specs: `booking` (requisito "Reprogramación por el staff" ampliado, delta en `specs/booking/spec.md`).
- Código: `src/features/booking/staff-slots.ts` (nuevo), `routes.ts`, `schemas.ts`; `findVisible` se exporta de `service.ts`.
- Clientes: botón "Reprogramar" en la Agenda del panel web (`frontend/`) y de la app (`mobile/`).
