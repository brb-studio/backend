# waitlist Specification

## Purpose
Que un cliente con cuenta pida que le avisen cuando se libere un horario que le sirve en un día lleno. Código: `src/features/waitlist/` (reglas puras en `rules.ts`, avisador en `notify.ts`).

## Requirements

### Requirement: Anotarse en la lista de espera
Un cliente con sesión SHALL poder anotarse con `POST /v1/me/waitlist` indicando sucursal, un servicio o un paquete, un día local, opcionalmente un barbero y una ventana horaria `from`/`to` (`HH:MM`, `from` menor que `to`). La entrada guarda el servicio o paquete tal como se mostró (slug y nombre) y vence al terminar ese día en la zona de la sucursal. Sin sesión de cliente, la respuesta es 401; un invitado MUST NOT poder anotarse. La suscripción inactiva bloquea anotarse (402 `SUBSCRIPTION_INACTIVE`).

#### Scenario: Día lleno
- **WHEN** un cliente se anota para un día en que el barbero no tiene horarios libres
- **THEN** la respuesta es 201 con el `id` de la entrada

#### Scenario: Visitante sin cuenta
- **WHEN** alguien sin sesión intenta anotarse
- **THEN** la respuesta es 401

### Requirement: Solo para días que se pueden reservar y están llenos
El día SHALL estar dentro de la ventana de reserva de la sucursal (no pasado y a no más de `windowDays`); si no, la respuesta es 422 `VALIDATION`. Si ya hay horarios libres que encajan con el servicio, el barbero y la ventana horaria pedidos, la respuesta es 409 `SLOTS_AVAILABLE`: el cliente debe reservar. Servicio, paquete, sucursal o barbero inexistentes, inactivos o que no pueden hacer el servicio responden 404.

#### Scenario: Ya hay horarios
- **WHEN** un cliente se anota para un día con horarios libres
- **THEN** la respuesta es 409 `SLOTS_AVAILABLE`

#### Scenario: Día fuera de la ventana
- **WHEN** el día pedido está más lejos que `windowDays`
- **THEN** la respuesta es 422 `VALIDATION`

### Requirement: Límites por cliente
Un cliente SHALL tener como máximo 5 entradas activas (409 `WAITLIST_FULL`) y no puede repetir la misma combinación de sucursal, día, servicio o paquete y barbero (409 `ALREADY_WAITING`).

#### Scenario: Sexta entrada
- **WHEN** un cliente con 5 entradas intenta anotarse otra vez
- **THEN** la respuesta es 409 `WAITLIST_FULL`

### Requirement: Ver y quitar las propias entradas
`GET /v1/me/waitlist` SHALL listar las entradas del cliente (sucursal, servicio o paquete, día, ventana y estado `waiting` o `notified`) y `DELETE /v1/me/waitlist/:id` quitar una. Un cliente MUST NOT ver ni borrar entradas de otro (404).

#### Scenario: Entrada ajena
- **WHEN** un cliente borra la entrada de otro cliente
- **THEN** la respuesta es 404 y la entrada sigue ahí

### Requirement: Aviso cuando se libera un horario
Con las tareas programadas, el sistema SHALL revisar las entradas en espera con la misma disponibilidad que la reserva pública (aviso mínimo, ventana, descansos y ausencias incluidos) y, cuando haya un horario que encaje, avisar al cliente por push y por correo con un enlace directo a reservar ese servicio en esa sucursal, y marcar la entrada `notified`. Cada entrada MUST avisar una sola vez. El horario no se reserva: por sucursal y día se avisa a los 3 primeros de la fila, por antigüedad, en cada corrida, y gana quien reserve primero; si en la siguiente corrida sigue libre, se avisa a los 3 siguientes. No se avisa a barberías con suscripción vencida.

#### Scenario: Se cancela una cita en un día lleno
- **WHEN** se libera un horario que encaja con una entrada en espera y corren las tareas programadas
- **THEN** el cliente recibe el aviso una sola vez aunque las tareas corran de nuevo

#### Scenario: Cuatro esperando
- **WHEN** cuatro clientes esperan el mismo día y se libera un horario
- **THEN** en la primera corrida se avisa a los tres más antiguos y en la siguiente, si sigue libre, al cuarto

#### Scenario: Ventana horaria que no encaja
- **WHEN** el cliente pidió de 07:00 a 08:00 y solo se liberan horarios de la tarde
- **THEN** no se le avisa

### Requirement: Limpieza
Las entradas SHALL borrarse solas al terminar su día (índice TTL). Cuando el cliente ya tiene una cita confirmada o por pagar ese día en la sucursal, o el servicio o paquete dejó de existir o de estar activo, la entrada MUST borrarse en la siguiente corrida sin avisar.

#### Scenario: El cliente ya reservó
- **WHEN** un cliente con entrada en espera reserva una cita ese día
- **THEN** su entrada se borra y no recibe aviso
