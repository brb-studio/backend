## Why
Al marcar una cita como completada no se guardaba cómo pagó el cliente en mostrador ni si pagó el resto del anticipo. Ganancias daba por cobrada toda cita completada y no había forma de cuadrar la caja del día.

## What Changes
- `PATCH /v1/appointments/:id` con `status: completed` pide `paidWith` (`cash`, `card`, `transfer`) cuando queda saldo; la cita guarda `counter` con el método, el saldo calculado por el API, quién lo recibió y cuándo.
- La vista de staff trae `dueMinor` (saldo por cobrar) en las confirmadas y `counter` en las cobradas.
- `GET /v1/cash?date=&branchId=` (owner, admin, manager): totales por método, por persona y movimientos del día, con productos entregados; cuenta los cortes completados sin cobro registrado.
- `GET /v1/earnings/summary` agrega `collected` (en línea, efectivo, tarjeta, transferencia, sin registrar).
- `GET /v1/appointments?date=` lista un día en la zona de cada sucursal; la agenda deja de calcular la medianoche en el navegador.
- Frontend: botones Efectivo · Tarjeta · Transferencia al completar, sección **Caja** y el desglose en Ganancias.

## Decisions
- **El monto nunca viene del cliente:** saldo = total − lo cobrado en línea y no reembolsado (`booking/counter.ts`, la misma regla del ticket).
- **Sin pagos parciales ni propinas** en mostrador; las propinas se descartaron antes.
- **Corte de caja como reporte**, sin guardar el efectivo contado: el encargado cuenta y compara con lo que dice la pantalla. Guardar cierres con diferencia queda para después.
- **Citas viejas** completadas sin cobro se ven como "sin registrar" en Ganancias y en la caja, en lugar de inventarles un método.
- **Zonas:** cada día es el día local de la sucursal; los cobros se agrupan por la hora del cobro, no por la de la cita (se aceptan completadas hasta 7 días tarde).
- Boy-scout: el cierre de citas sale de `booking/service.ts` a `booking/close.ts`.

## Impact
- Specs: `booking` (agenda por día local, cambios de estado), `platform-dashboard` (Ganancias, corte de caja).
- Código: `src/db/collections.ts` (`counter`, `COUNTER_METHODS`), `src/features/booking/{counter,close,views,schemas,service}.ts`, `src/features/cash/`, `src/features/platform/revenue.ts`; pruebas `tests/counter.test.ts`, `tests/agenda-day.test.ts`, `tests/platform.test.ts`.
