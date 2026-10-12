# booking Specification

## Purpose
Ciclo de vida de una cita: reserva en línea y por el staff, protección contra doble reserva, precio congelado, clientes, cancelación, reprogramación y cambios de estado. Código: `src/features/booking/`.

## Requirements

### Requirement: Reserva en línea
`POST /v1/public/appointments` SHALL aceptar los slugs de sucursal y barbero, exactamente uno de servicio o paquete, un inicio ISO con zona y, opcionalmente, código promocional y notas (máximo 500). Un cliente con sesión reserva como sí mismo; un invitado MUST enviar nombre (2 a 80 caracteres) y teléfono, y el correo es opcional. La respuesta incluye un `paymentToken` (ver `appointment-payments`).

#### Scenario: Invitado sin datos
- **WHEN** un invitado reserva sin `customer`
- **THEN** la respuesta es 422 `VALIDATION` con el campo `customer`

#### Scenario: Servicio y paquete a la vez
- **WHEN** el cuerpo trae `service` y `package`
- **THEN** la respuesta es 422 `VALIDATION`

### Requirement: Reserva que se paga en línea
Con `payment`, la cita SHALL nacer `pending_payment` y apartar el horario hasta que se pague o venza (ver `appointment-payments`). Si la barbería exige anticipo, reservar sin `payment` MUST responder 422 `PAYMENT_REQUIRED`. Las reservas del staff nunca exigen pago.

#### Scenario: Barbería con anticipo, reserva del staff
- **WHEN** el staff agenda a un cliente en una barbería que exige anticipo
- **THEN** la cita queda `confirmed` sin pago

### Requirement: Límites de la reserva en línea
La reserva en línea MUST limitarse a 20 reservas por hora por IP y barbería, y a 5 por hora por cliente (por teléfono o por cuenta). Al pasarse, la respuesta es 429 `RATE_LIMITED`.

#### Scenario: Sexta reserva del mismo teléfono
- **WHEN** el mismo teléfono hace su sexta reserva en una hora
- **THEN** la respuesta es 429 `RATE_LIMITED`

### Requirement: Reserva por el staff
El staff SHALL poder reservar por ids (para clientes que llegan sin cita o llaman por teléfono) con `customerId` o con los datos de un cliente nuevo, pero no con ambos. Estas reservas no tienen anticipación mínima y aceptan hasta 365 días adelante. Un barbero MUST reservar solo para sí mismo. La cita guarda `source: "staff"` y quién la creó.

#### Scenario: Barbero reserva para otro barbero
- **WHEN** un barbero crea una cita con el id de otro barbero
- **THEN** la respuesta es 403 `FORBIDDEN`

### Requirement: Sin doble reserva
Cada reserva SHALL ejecutarse en una transacción que bloquea al barbero (incrementa su `lockVersion`), revalida el horario con el motor de disponibilidad, canjea la promoción y guarda la cita junto con el aviso al barbero (o, si se paga en línea, junto con su pago; el aviso llega al confirmarse el pago). Antes se cancelan los apartados vencidos. Un índice único parcial sobre `{ barberId, startAt }` de las citas `confirmed` y `pending_payment` MUST respaldar esto en la base de datos.

#### Scenario: Dos clientes, mismo horario, mismo barbero
- **WHEN** dos reservas para el mismo barbero y la misma hora llegan al mismo tiempo
- **THEN** exactamente una se confirma y la otra responde 409 `SLOT_TAKEN`

### Requirement: Barbero apto y duración máxima
La reserva MUST revalidar que el barbero puede atender la solicitud (ver `catalog`); si no puede, responde 409 `BARBER_UNAVAILABLE`. Una cita MUST NOT durar más de 720 minutos; si los pasa, responde 422 `TOO_LONG`.

#### Scenario: Barbero que ya no hace el servicio
- **WHEN** se reserva un servicio que el barbero dejó de hacer
- **THEN** la respuesta es 409 `BARBER_UNAVAILABLE`

#### Scenario: Más larga que una jornada
- **WHEN** la duración total pasa de 720 minutos
- **THEN** la respuesta es 422 `TOO_LONG`

### Requirement: Datos congelados al reservar
La cita SHALL guardar una copia de lo vendido: nombre, duración y precio de cada servicio o paquete, subtotal, descuento, total, moneda, términos de la promoción y zona horaria de la sucursal. El historial, las cancelaciones y las reprogramaciones MUST leer esta copia y nunca el catálogo actual.

#### Scenario: Cambio de precio después de reservar
- **WHEN** el servicio sube de precio después de la reserva
- **THEN** la cita conserva el precio y el total originales

### Requirement: Precio cotizado igual al cobrado
La cotización (`POST /v1/public/quote`) y la reserva SHALL calcular el precio con la misma función (ver `promotions`). La cotización devuelve subtotal, descuento, total, la promoción aplicada y, si un código no aplica, el motivo. Para evaluar la primera visita usa el teléfono enviado o la cuenta con sesión. Se limita a 30 por IP cada 10 minutos. Si la reserva trae un código que no aplica, MUST responder 409 `PROMOTION_UNAVAILABLE` con el motivo.

#### Scenario: Código vencido al reservar
- **WHEN** el código venció entre la cotización y la reserva
- **THEN** la reserva responde 409 `PROMOTION_UNAVAILABLE` y no se crea la cita

### Requirement: Cotización de pagos en línea
Si la barbería tiene pagos en línea, la cotización SHALL incluir `online`: si el pago es obligatorio, el total, el anticipo y cada opción (`options`: tipo, método, cargo y reembolsable al cancelar a tiempo). Se calcula con las mismas reglas que el cobro y con la promoción ya aplicada, para que la pantalla MUST NOT calcular montos por su cuenta.

#### Scenario: Primera visita con anticipo
- **WHEN** un invitado nuevo cotiza un servicio de 20.00 con 15% de primera visita y anticipo de 25%
- **THEN** el total es 17.00, el anticipo 10.00 (el mínimo de Stripe) y cada opción trae su reembolsable

### Requirement: Identidad del cliente
El sistema SHALL identificar a los invitados por su teléfono normalizado (sin espacios, guiones ni paréntesis). La primera reserva crea el cliente y las siguientes lo reutilizan sin sobrescribir su nombre. Si una cuenta de cliente tiene el mismo teléfono que un cliente invitado sin cuenta, el sistema MUST vincularlos en lugar de duplicarlos. Un cliente con sesión ve sus últimas 50 citas, de la más nueva a la más vieja.

#### Scenario: Invitado que después crea cuenta
- **WHEN** alguien reservó como invitado y después se registra con el mismo teléfono y reserva
- **THEN** su historial incluye las citas que hizo como invitado

### Requirement: Cancelación por el cliente
Un cliente con sesión SHALL poder cancelar solo sus propias citas confirmadas, y solo hasta `cancelNoticeMin` minutos antes del inicio; después la respuesta MUST ser 409 `TOO_LATE`. Al cancelar:
- se devuelve el uso de la promoción;
- se avisa al barbero;
- si estaba pagada en línea, se reembolsa según la política de `appointment-payments`.

#### Scenario: Cancelar demasiado tarde
- **WHEN** faltan 60 minutos y `cancelNoticeMin` es 120
- **THEN** la respuesta es 409 `TOO_LATE`

### Requirement: Abandonar una reserva sin pagar
Un cliente con sesión SHALL poder cancelar en cualquier momento su propia cita aún `pending_payment`: se cancela con `cancelReason: "cancelled_by_customer"`, MUST liberarse el horario y se cancela su cobro en Stripe, sin reembolso porque nada se cobró.

#### Scenario: Cliente cierra el pago y cancela
- **WHEN** el cliente cancela una cita que no ha pagado
- **THEN** el horario queda libre de inmediato

### Requirement: Reprogramación por el cliente
Un cliente con sesión SHALL poder mover su propia cita confirmada, con el mismo barbero, hasta `cancelNoticeMin` minutos antes del inicio (después, 409 `TOO_LATE`). El nuevo horario MUST estar dentro de `windowDays` y respetar `minNoticeMin`. Los horarios que se le ofrecen (`GET /v1/me/appointments/:id/slots`) usan la duración y los servicios guardados en la cita y no cuentan la propia cita como ocupada. Si el barbero ya no hace esos servicios, la respuesta es 409 `BARBER_UNAVAILABLE`.

#### Scenario: Mover la cita 15 minutos
- **WHEN** el cliente mueve su cita de 10:00 a 10:15 y nadie más ocupa ese horario
- **THEN** el cambio se acepta aunque el horario nuevo se encime con el anterior

### Requirement: Agenda del staff
El staff SHALL listar citas por rango, de máximo 62 días; por defecto, desde 12 horas atrás hasta 7 días adelante. Owner y admin ven todas, el manager las de su sucursal y el barbero solo las suyas.

#### Scenario: Barbero consulta la agenda
- **WHEN** un barbero lista las citas de la semana
- **THEN** solo recibe las suyas

### Requirement: Cambios de estado por el staff
El staff SHALL poder marcar una cita confirmada como `completed` o `no_show`, solo después de su inicio (antes, 409 `NOT_STARTED`), o como `cancelled`, con motivo opcional; cancelar una cita pagada en línea devuelve el pago completo. Un `PATCH` MUST cambiar el estado o reprogramar, no ambos; ambos pueden traer notas. Las citas que no están confirmadas responden 409 `NOT_CONFIRMED`.

#### Scenario: Marcar "no vino" antes de la hora
- **WHEN** el staff marca `no_show` una cita que empieza en una hora
- **THEN** la respuesta es 409 `NOT_STARTED`

#### Scenario: Estado y reprogramación juntos
- **WHEN** un `PATCH` trae `status` y `startAt`
- **THEN** la respuesta es 422 `VALIDATION`

### Requirement: Reprogramación por el staff
El staff SHALL poder mover una cita confirmada a otro horario y/o a otro barbero, hasta 365 días adelante. El cambio MUST revalidarse con el motor sin contar la propia cita como ocupada. Un barbero no puede pasar su cita a otro barbero (403 `FORBIDDEN`).

#### Scenario: Barbero pasa su cita a un compañero
- **WHEN** un barbero cambia el `barberId` de su cita
- **THEN** la respuesta es 403 `FORBIDDEN`
