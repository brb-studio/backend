## Why
Cuando un día está lleno el cliente se va con la competencia, y cuando alguien cancela el horario queda vacío. La lista de espera junta las dos puntas: el cliente pide que le avisen y la barbería recupera la cita.

## What Changes
- Un cliente con cuenta se anota ("Avísame si se libera") para un servicio o paquete, una sucursal, un día, opcionalmente un barbero y una ventana horaria.
- Cuando aparece un horario que encaja, recibe push y correo con un enlace directo a reservar.
- Puede ver y borrar sus entradas desde su cuenta.
- Nueva capability `waitlist`.

## Decisions
- **Sin enganches en las rutas de cancelar/reprogramar.** El avisador corre en las tareas programadas (≤10 min) y recalcula la disponibilidad con el mismo motor que la reserva. Así cubre cualquier forma de liberar un horario (cancelación, reprogramación, apartado vencido, ausencia borrada, horario nuevo) sin tocar `booking/service.ts` (894 líneas).
- **Sin reservar el hueco.** Se avisa a los 3 primeros de la fila por sucursal y día en cada corrida; gana quien reserve primero. Si el horario sigue libre en la siguiente corrida, avisa a los 3 siguientes.
- **Una entrada avisa una sola vez.** Queda en `notified` hasta que pase su día; si el cliente quiere otro aviso, se anota de nuevo.
- **Solo cuentas.** Un invitado no puede anotarse (evita usar el correo de otra persona para mandarle avisos). Máximo 5 entradas activas por cliente.
- **No se puede anotar si ya hay horarios que encajan** (409 `SLOTS_AVAILABLE`): en ese caso debe reservar.
- Las entradas se borran solas al terminar su día (TTL) y cuando el cliente ya tiene una cita ese día en la sucursal.

## Impact
- Specs: nueva `waitlist`; `availability` (motor reutilizado por el avisador); `notifications` (tarea programada).
- Código: `src/features/waitlist/`, `openSlots` en `availability/service.ts`, `platform/digest.ts`, `src/db/collections.ts`, `src/app.ts`. Frontend: formulario en la página del servicio y sección en la cuenta.
