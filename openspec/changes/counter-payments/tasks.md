## 1. Backend
- [x] 1.1 `counter` y `COUNTER_METHODS` en citas, con validador.
- [x] 1.2 `dueAtCounter()` puro con prueba; el ticket usa la misma regla.
- [x] 1.3 `closeAppointment()` en `booking/close.ts`: `paidWith` obligatorio con saldo.
- [x] 1.4 `GET /v1/cash` con totales, personas, movimientos y sin registrar.
- [x] 1.5 `collected` en `GET /v1/earnings/summary`.
- [x] 1.6 `GET /v1/appointments?date=` por día local de cada sucursal.
- [x] 1.7 Pruebas de integración; suite completa con `TZ` UTC+14 y UTC−11.

## 2. Frontend
- [x] 2.1 Agenda: cobrar con Efectivo · Tarjeta · Transferencia y mostrar lo cobrado; día por fecha.
- [x] 2.2 Sección "Caja" (owner, admin, manager).
- [x] 2.3 Desglose en Ganancias.
- [x] 2.4 Fecha de "Hoy" y plazo de pago en la zona de la sucursal.

## 3. Specs
- [x] 3.1 `booking`, `platform-dashboard`; README.
- [ ] 3.2 Guardar cierres de caja con el efectivo contado y la diferencia (si se pide).
