# appointment-payments Specification

## Purpose
Pago de las citas por transferencia SPEI directa a la cuenta bancaria de cada barbería. El dinero va del cliente a la barbería: la plataforma no lo recibe, custodia ni redistribuye. La primera versión confirma a mano (la barbería revisa su banco); no hay integración bancaria. Código: `src/features/payments/`. Stripe queda solo para la suscripción de las barberías a la app (`subscription-billing`).

## Requirements

### Requirement: Cuenta bancaria de la barbería
La barbería SHALL guardar en su documento `bankAccountKey` (CLABE de 18 dígitos con dígito verificador válido), `bankAccountHolder` (titular) y `bankTransferEnabled`. Solo owner y admin MUST poder leerlos y cambiarlos (`GET`/`PATCH /v1/payments/settings`; el cambio exige suscripción activa). Activar las transferencias SHALL requerir CLABE y titular; una barbería que no las quiera no necesita cuenta. Los datos bancarios MUST NOT aparecer en `GET /v1/public/tenant` (solo `payments.transfer`, un booleano), en `GET /v1/tenant` ni en ninguna otra respuesta salvo la del cliente que pidió pagar. No se guardan contraseñas ni credenciales bancarias.

#### Scenario: CLABE con dígito verificador incorrecto
- **WHEN** el owner guarda una CLABE cuyo último dígito no corresponde
- **THEN** la respuesta es 422 `VALIDATION` y nada cambia

### Requirement: Pedir los datos de pago
`POST /v1/public/payments/transfer` con `{ appointmentId, paymentToken? }` SHALL crear un pago `pending` por el total de la cita confirmada, en su moneda, con una copia de la CLABE y el titular vigentes. Importe, moneda, barbería y cuenta MUST salir de la base de datos, nunca de la petición. Pedirlo otra vez mientras sigue pendiente devuelve el mismo pago. Un cambio posterior de la cuenta bancaria no altera los pagos ya pedidos. Vence a las 48 h (`expired`); después se puede pedir uno nuevo.

Se rechaza con: 409 `TRANSFER_NOT_AVAILABLE` (transferencias apagadas o sin CLABE), 422 `NOTHING_TO_CHARGE` (total 0), 409 `ALREADY_PAID`, 429 `RATE_LIMITED` (más de 30 intentos en 10 minutos por IP y barbería) y 404 si la cita no existe, no está confirmada o no es del solicitante.

#### Scenario: Barbería sin CLABE
- **WHEN** se pide pagar por transferencia a una barbería sin cuenta configurada
- **THEN** la respuesta es 409 `TRANSFER_NOT_AVAILABLE` y no se crea ningún pago

### Requirement: Solo quien reservó puede pedirlo
Un invitado SHALL demostrar que reservó con el `paymentToken` de la respuesta de reserva: un HMAC del id de la cita con `PAYMENT_TOKEN_SECRET` (obligatorio en producción), que no se guarda y se compara en tiempo constante. Un cliente con sesión solo MUST poder pedir pagar sus propias citas; el staff no paga por el cliente (403). En cualquier otro caso la respuesta es 404 `NOT_FOUND`.

#### Scenario: Id ajeno sin token
- **WHEN** un invitado pide pagar una cita con un id válido pero sin token o con el de otra cita
- **THEN** la respuesta es 404 `NOT_FOUND`

### Requirement: Confirmar o rechazar
Solo owner y admin de la misma barbería SHALL listar (`GET /v1/payments?status=`), confirmar (`POST /v1/payments/:id/confirm`) y rechazar (`POST /v1/payments/:id/reject`) pagos; el cliente nunca confirma el suyo. Confirmar exige `receivedMinor` igual al importe pedido (si no, 422 `AMOUNT_MISMATCH`), que el total de la cita no haya cambiado (409 `AMOUNT_CHANGED`) y que la cita no esté cancelada (409 `APPOINTMENT_NOT_PAYABLE`); acepta una `reference` (clave de rastreo) opcional. Las únicas transiciones son `pending → paid | rejected | expired`; cualquier otra, incluida repetir una confirmación, es 409 `INVALID_TRANSITION` y no repite efectos. El pago y el resumen `appointment.payment` cambian en una misma transacción. Cada transición queda en `history` con fecha y usuario. Un pago de otra barbería es 404.

#### Scenario: Confirmación duplicada
- **WHEN** se confirma dos veces el mismo pago
- **THEN** la segunda respuesta es 409 `INVALID_TRANSITION` y `history` conserva solo `pending` y `paid`

### Requirement: Datos históricos de Stripe
Las citas con `payment.provider = "stripe"` MUST conservarse sin cambios (`intentId`, `applicationFeeMinor`, estados `requires_payment`, `paid`, `refunded`, `failed`) y siguen contando como cobradas en el panel de la plataforma si están `paid`. El campo `stripe` de la barbería queda como lectura heredada. Ya no se cobra por Stripe Connect ni se reembolsa automáticamente al cancelar; reembolsar es asunto de la barbería.

#### Scenario: Cita antigua pagada con Stripe
- **WHEN** un cliente cancela una cita pagada con Stripe antes del cambio
- **THEN** la cita se cancela y su pago sigue `paid`

### Requirement: Vista pública de la barbería
El sistema SHALL exponer en `GET /v1/public/tenant`, sin sesión: nombre, moneda, idiomas, idioma por defecto, tema, marca, sucursales activas ordenadas por nombre e indicador `payments.transfer`. El sistema MUST NOT exponer en esta vista la suscripción, datos bancarios ni datos internos.

#### Scenario: Visitante sin sesión
- **WHEN** alguien consulta la barbería sin sesión
- **THEN** recibe esos campos y ningún dato bancario
