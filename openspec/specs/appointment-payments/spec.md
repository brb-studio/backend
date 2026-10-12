# appointment-payments Specification

## Purpose
Pago de las citas. Dos caminos: **en línea** con Stripe Connect (tarjeta o transferencia SPEI a una CLABE que genera Stripe), confirmado solo por webhook, y **manual** por transferencia SPEI directa a la CLABE de la barbería, confirmado a mano. En línea, la plataforma cobra (destination charges) y Stripe transfiere a la cuenta conectada de la barbería el cobro menos la comisión que cubre a Stripe; la plataforma no custodia el dinero. Código: `src/features/payments/` (reglas puras en `rules.ts`).

## Requirements

### Requirement: Cuenta conectada de la barbería
Owner y admin SHALL activar los pagos en línea con `POST /v1/payments/stripe/onboarding` (`{ locale? }`). La primera vez se crea una cuenta conectada (Accounts v2, país MX, configuración `recipient`, dashboard `express`, comisiones y pérdidas a cargo de la plataforma); cada vez se devuelve un enlace nuevo de un solo uso al formulario de Stripe. La cuenta MUST crearse una sola vez aunque se pida dos veces a la vez.

#### Scenario: Dos clics seguidos
- **WHEN** el owner pide el formulario dos veces
- **THEN** Stripe crea una sola cuenta y ambas respuestas traen un enlace

#### Scenario: Regreso al panel
- **WHEN** el owner termina o abandona el formulario
- **THEN** Stripe lo regresa a `/<locale>/admin/payments?stripe=return` (o `refresh`) del host de su barbería

### Requirement: Estado de la cuenta conectada
El estado (`onboarding`, `pending`, `active`, `restricted`) y lo que Stripe aún pide (`requirementsDue`) MUST salir de Stripe: lo cambian los eventos de cuenta del webhook, que releen la cuenta, o `POST /v1/payments/stripe/refresh`, nunca el regreso del formulario. `GET /v1/payments/stripe` lo muestra sin ids de Stripe.

#### Scenario: Registro aprobado
- **WHEN** Stripe avisa que la capacidad de transferencias quedó `active`
- **THEN** la barbería queda `active` y la vista pública marca `payments.online: true`

### Requirement: Panel Express y errores de Stripe
`POST /v1/payments/stripe/dashboard` SHALL dar un enlace al panel Express de la barbería una vez terminado el registro (si no, 409 `ONBOARDING_INCOMPLETE`). Sin llaves de Stripe en el servidor, las rutas de Stripe responden 503 `ONLINE_PAYMENTS_DISABLED`; si Stripe no responde, MUST responder 502 `PAYMENT_PROVIDER_ERROR`.

#### Scenario: Stripe caído
- **WHEN** Stripe no responde al pedir el formulario
- **THEN** la respuesta es 502 `PAYMENT_PROVIDER_ERROR`

### Requirement: Anticipo configurable
Owner y admin SHALL configurar `PATCH /v1/payments/deposit` con `{ enabled, percentBps }` (100 a 10000). Con el anticipo activo, reservar en línea MUST exigir pagar al menos el anticipo (sin pago: 422 `PAYMENT_REQUIRED`); sin anticipo, el cliente puede pagar completo en línea o reservar como siempre.

#### Scenario: Reservar sin pagar en una barbería con anticipo
- **WHEN** un cliente reserva sin `payment` y la barbería exige anticipo
- **THEN** la respuesta es 422 `PAYMENT_REQUIRED` y no se crea la cita

### Requirement: Monto del anticipo
El anticipo SHALL ser `percentBps` del total de la cita (con promoción, el mismo `priceFor()` de la reserva), redondeado hacia arriba al peso completo, subido al mínimo de Stripe (10.00 MXN) y nunca mayor al total. Si iguala al total, solo existe el pago completo. Una cita de menos de 10.00 MXN MUST NOT cobrarse en línea.

#### Scenario: 25% de un corte de 250.00
- **WHEN** el cliente paga el anticipo de un corte de 250.00 con anticipo de 25%
- **THEN** se cobran 63.00 y quedan 187.00 por pagar en la barbería

### Requirement: Reserva con pago en línea
`POST /v1/public/appointments` SHALL aceptar `payment: { kind: "deposit" | "full", method: "card" | "bank_transfer" }`. El importe MUST salir de la cita, nunca de la petición. Solo se acepta si la barbería tiene la cuenta `active`, moneda MXN o USD y Stripe configurado; si no, 409 `ONLINE_PAYMENT_UNAVAILABLE`, y la reserva sin pago funciona como siempre.

#### Scenario: Monto enviado por el cliente
- **WHEN** el cuerpo trae `payment.amountMinor`
- **THEN** la respuesta es 422 `VALIDATION` y no se aparta nada

#### Scenario: Barbería sin Stripe activo
- **WHEN** se pide pagar en línea en una barbería sin cuenta activa
- **THEN** la respuesta es 409 `ONLINE_PAYMENT_UNAVAILABLE`

### Requirement: Cobros en dólares
Una barbería en USD SHALL cobrar solo con tarjeta (incluidas Apple Pay y Google Pay) y Link: la transferencia bancaria de México solo acepta MXN, así que el API MUST rechazarla con 409 `METHOD_UNAVAILABLE` al reservar y al cambiar de método, y la vista pública lista los métodos (`payments.methods`). El mínimo es USD 0.50 y el anticipo se redondea hacia arriba al dólar completo. Stripe convierte el cobro a pesos y deposita a la CLABE de la barbería en MXN.

#### Scenario: Transferencia en una barbería en dólares
- **WHEN** un cliente de una barbería en USD pide pagar por transferencia
- **THEN** la respuesta es 409 `METHOD_UNAVAILABLE` y no se aparta el horario

### Requirement: Apartado del horario
En la misma transacción de la reserva SHALL crearse la cita en `pending_payment` con `paymentDeadline` (20 minutos con tarjeta, 60 con transferencia; configurables) y su pago. Ese estado aparta el horario hasta el deadline. Una transferencia MUST NOT ofrecerse si el deadline queda después del inicio de la cita (409 `TRANSFER_TOO_LATE`).

#### Scenario: Horario apartado
- **WHEN** otra persona intenta reservar el mismo horario mientras el primero paga
- **THEN** responde 409 `SLOT_TAKEN` y la disponibilidad no ofrece ese horario

### Requirement: Cobro en Stripe
Después del commit SHALL crearse el PaymentIntent (idempotency key por pago) con `transfer_data.destination` = cuenta de la barbería, `application_fee_amount` = comisión de Stripe estimada más IVA por moneda (MXN: tarjeta nacional 3.6% + 3.00, transferencia 7.00; USD: tarjeta extranjera 3.6% + 0.5% + 2% de conversión + 0.20; configurables) y `metadata { tenantId, appointmentId, paymentId, kind }`. Si Stripe falla, el apartado MUST liberarse de inmediato (502 `PAYMENT_PROVIDER_ERROR`).

#### Scenario: Respuesta con tarjeta
- **WHEN** se reserva pagando con tarjeta
- **THEN** `checkout` trae `clientSecret` para el Payment Element, el monto y el restante

#### Scenario: Respuesta con transferencia
- **WHEN** se reserva pagando por transferencia
- **THEN** `checkout` trae la CLABE, el banco, la referencia y el monto restante que dio Stripe

#### Scenario: Stripe falla al crear el cobro
- **WHEN** Stripe no responde al crear el PaymentIntent
- **THEN** la respuesta es 502 y el horario queda libre otra vez

### Requirement: Estado y cambio del pago
`GET /v1/public/appointments/:id/payment` SHALL devolver el estado de la cita y del pago (tipo, método, monto, restante, deadline, marca y últimos 4, instrucciones de transferencia); con `secret=1` vuelve a dar el `clientSecret` de una tarjeta pendiente. `POST` a la misma ruta con `{ kind, method }` MUST cambiar cómo o cuánto se paga mientras siga `pending_payment`, con el mismo deadline.

#### Scenario: De tarjeta a transferencia
- **WHEN** el cliente cambia a transferencia antes del deadline
- **THEN** el cobro con tarjeta se cancela en Stripe y recibe la CLABE del nuevo cobro

#### Scenario: Ya se había pagado
- **WHEN** el cobro anterior resulta pagado al intentar cancelarlo
- **THEN** la respuesta es 409 `ALREADY_PAID` y la cita se confirma

### Requirement: Webhook verificado
`POST /webhooks/stripe` (fuera de `/v1`, sin host de barbería) SHALL verificar `Stripe-Signature` sobre el cuerpo crudo, con cualquiera de los secretos de `STRIPE_WEBHOOK_SECRET` y 5 minutos de tolerancia, antes de leer nada. Cada evento se registra por id. Errores de base de datos o de Stripe responden 500 para que Stripe reintente; los demás MUST registrarse y responder 200.

#### Scenario: Firma inválida
- **WHEN** llega un evento con firma incorrecta o vieja
- **THEN** la respuesta es 400 `BAD_SIGNATURE` y no se procesa

#### Scenario: Evento repetido
- **WHEN** Stripe entrega dos veces el mismo evento
- **THEN** la segunda vez responde 200 sin efectos

### Requirement: Confirmación solo por webhook
Ante un evento de PaymentIntent el sistema SHALL releerlo en Stripe, ubicar barbería y pago por `metadata` y comprobar que importe, moneda y cuenta destino coinciden con lo guardado; si no, lo ignora. Con `succeeded` y el monto completo, en una transacción el pago pasa a `paid`, la cita a `confirmed` y se guarda el aviso al barbero. Una transferencia incompleta MUST NOT confirmar.

#### Scenario: Transferencia de menos
- **WHEN** llega una transferencia por menos del monto
- **THEN** la cita sigue `pending_payment` y el monto restante se actualiza

#### Scenario: Tarjeta rechazada
- **WHEN** Stripe reporta un fallo de tarjeta
- **THEN** el cliente puede reintentar con otra tarjeta hasta el deadline

### Requirement: Vencimiento del apartado
Una cita `pending_payment` con el deadline vencido SHALL dejar de ocupar el horario aunque aún no se cancele. Antes de reservar, reprogramar, listar las citas del cliente o consultar un pago, el sistema cancela esas citas (`payment_expired`), devuelve la promoción, marca el pago `expired` y MUST cancelar el PaymentIntent en Stripe.

#### Scenario: Nadie pagó a tiempo
- **WHEN** vence el deadline sin pago
- **THEN** otra persona puede reservar ese horario y la cita original queda cancelada

### Requirement: Pagos tardíos
Si el dinero llega después de terminado el apartado, o por un cobro que el cliente reemplazó, SHALL reembolsarse completo. La decisión MUST tomarse con lo guardado, para que un reintento del webhook complete un reembolso que falló y nunca reembolse dos veces. Lo que llegue al saldo del cliente en Stripe sin un cobro abierto se registra para revisión.

#### Scenario: Pago después del deadline
- **WHEN** el pago con tarjeta se completa cuando la cita ya se canceló por vencimiento
- **THEN** se reembolsa completo y la cita sigue cancelada

### Requirement: Reembolso al cancelar
Al cancelar una cita pagada en línea SHALL aplicarse `refundOnCancel` (función pura): si cancela la barbería se devuelve todo; si cancela el cliente antes de `cancelNoticeMin`, se devuelve lo pagado menos la comisión de Stripe de ese pago (no reembolsable); después, se conserva. El checkout y el ticket de la cita MUST mostrar ese monto (`refundableMinor`) antes de pagar y al cancelar. Un reembolso que falla se registra sin deshacer la cancelación.

#### Scenario: Cliente cancela a tiempo
- **WHEN** el cliente cancela a tiempo una cita de 300.00 pagada con tarjeta
- **THEN** recibe 283.99 y la comisión de 16.01 se queda

#### Scenario: La barbería cancela a última hora
- **WHEN** el staff cancela una cita pagada cinco minutos antes
- **THEN** el cliente recibe el pago completo

### Requirement: Reembolso exacto a la barbería
Cada reembolso SHALL revertir de la transferencia de la barbería exactamente lo reembolsado, hasta lo que ella recibió (una reversión explícita, no la proporcional de `reverse_transfer`). Lo que la transferencia no cubre es la comisión que retuvo la plataforma. Si quien cancela o reembolsa es la barbería, ese faltante MUST sumarse a su `stripeConnect.feeDebtMinor`, en la moneda del pago (`feeDebtCurrency`); si fue el cliente o un pago tardío, no.

#### Scenario: Reembolso completo por la barbería
- **WHEN** la barbería reembolsa completa una cita de 300.00
- **THEN** se le revierten 283.99 y su saldo pendiente sube 16.01

### Requirement: Saldo pendiente de comisiones
El saldo pendiente de la barbería SHALL cobrarse sumándolo al `application_fee_amount` de sus siguientes cobros, sin dejar a la barbería sin nada del cobro. La parte cobrada se descuenta del saldo dentro de la transacción de la reserva y MUST volver al saldo si ese pago vence o se reemplaza. Solo la cobran pagos en la moneda de la deuda; montos en monedas distintas nunca se suman. El cliente nunca paga esa deuda. `GET /v1/payments/stripe` muestra `feeDebtMinor` y `feeDebtCurrency`.

#### Scenario: Siguiente cobro
- **WHEN** la barbería debe 5.00 y un cliente reserva pagando 300.00 con tarjeta
- **THEN** la plataforma retiene 16.01 + 5.00 y el saldo pendiente queda en 0

### Requirement: Reembolso manual
Owner y admin SHALL reembolsar todo o parte con `POST /v1/payments/appointments/:id/refund` (`{ amountMinor? }`, por defecto lo que queda). Más de lo pagado es 422 `REFUND_TOO_LARGE`; un pago no pagado, 409 `NOT_REFUNDABLE`. Es un reembolso de la barbería: lo que su transferencia no cubra MUST sumarse a su saldo pendiente. El total reembolsado sigue a Stripe (`charge.refunded`), incluidos los hechos en su panel.

#### Scenario: Reembolso parcial
- **WHEN** el owner reembolsa 100.00 de un pago de 300.00
- **THEN** se le revierten 100.00, el pago sigue `paid` y el saldo pendiente no cambia

### Requirement: Disputas
Con `charge.dispute.created`, el pago y el ticket de la cita SHALL quedar `disputed` y cada owner y admin activo MUST recibir un aviso `payment.disputed`, en una transacción.

#### Scenario: Contracargo
- **WHEN** el tarjetahabiente abre una disputa
- **THEN** la cita muestra "en disputa" y el owner recibe el aviso

### Requirement: Ticket de la cita
La cita SHALL guardar una copia de su último pago (`payment`): proveedor, método, tipo, estado, monto, reembolsado, comisión, marca y últimos 4 de la tarjeta (nunca el número) y fecha de pago. Las vistas del cliente y del staff agregan `paidMinor` y `balanceMinor`. El documento `payments` MUST ser la fuente de verdad y guardar cada transición en `history`.

#### Scenario: Anticipo pagado
- **WHEN** el staff abre una cita con anticipo pagado de 63.00 sobre 250.00
- **THEN** ve `kind: "deposit"`, `paidMinor: 6300` y `balanceMinor: 18700`

### Requirement: Cuenta bancaria de la barbería
La barbería SHALL guardar `bankAccountKey` (CLABE de 18 dígitos con dígito verificador válido), `bankAccountHolder` y `bankTransferEnabled`; es el respaldo sin pagos en línea. Solo owner y admin leen y cambian estos datos (`GET`/`PATCH /v1/payments/settings`, con suscripción activa). Activar exige CLABE y titular. Los datos bancarios MUST NOT aparecer en ninguna respuesta salvo la del cliente que pidió pagar.

#### Scenario: CLABE con dígito verificador incorrecto
- **WHEN** el owner guarda una CLABE cuyo último dígito no corresponde
- **THEN** la respuesta es 422 `VALIDATION` y nada cambia

### Requirement: Pedir los datos de pago
`POST /v1/public/payments/transfer` con `{ appointmentId, paymentToken? }` SHALL crear un pago manual (`spei`) `pending` por el total de la cita confirmada, con copia de la CLABE y el titular vigentes. Importe, moneda y cuenta MUST salir de la base de datos. Pedirlo otra vez mientras sigue pendiente devuelve el mismo pago. Vence a las 48 h (`expired`).

#### Scenario: Barbería sin CLABE
- **WHEN** se pide pagar por transferencia a una barbería sin cuenta configurada
- **THEN** la respuesta es 409 `TRANSFER_NOT_AVAILABLE` y no se crea ningún pago

#### Scenario: Otros rechazos
- **WHEN** el total es 0, la cita ya está pagada o hay más de 30 intentos en 10 minutos
- **THEN** responde 422 `NOTHING_TO_CHARGE`, 409 `ALREADY_PAID` o 429 `RATE_LIMITED`

### Requirement: Solo quien reservó puede pedirlo
Un invitado SHALL demostrar que reservó con el `paymentToken` de la respuesta de reserva: un HMAC del id de la cita con `PAYMENT_TOKEN_SECRET`, que no se guarda y se compara en tiempo constante. Un cliente con sesión solo MUST poder pagar o consultar sus propias citas; el staff no paga por el cliente (403). En cualquier otro caso, 404 `NOT_FOUND`.

#### Scenario: Id ajeno sin token
- **WHEN** un invitado pide pagar una cita con un id válido pero sin token o con el de otra cita
- **THEN** la respuesta es 404 `NOT_FOUND`

### Requirement: Confirmar o rechazar
Solo owner y admin SHALL listar (`GET /v1/payments?status=`), confirmar (`POST /v1/payments/:id/confirm`) y rechazar (`POST /v1/payments/:id/reject`) pagos manuales; los pagos en línea nunca pasan por esa cola. Confirmar MUST exigir `receivedMinor` igual al importe (422 `AMOUNT_MISMATCH`), total sin cambios (409 `AMOUNT_CHANGED`) y cita no cancelada (409 `APPOINTMENT_NOT_PAYABLE`).

#### Scenario: Confirmación duplicada
- **WHEN** se confirma dos veces el mismo pago
- **THEN** la segunda respuesta es 409 `INVALID_TRANSITION` y `history` conserva solo `pending` y `paid`

#### Scenario: Pago de otra barbería
- **WHEN** el owner confirma un pago que no es de su barbería
- **THEN** la respuesta es 404

### Requirement: Datos históricos de Stripe
Las citas con `payment.provider = "stripe"` sin `paymentId` (Stripe Connect anterior a 2026) MUST conservarse sin cambios y siguen contando como cobradas en el panel de la plataforma si están `paid`. El campo `stripe` de la barbería queda como lectura heredada; la cuenta actual vive en `stripeConnect`.

#### Scenario: Cita antigua pagada con Stripe
- **WHEN** un cliente cancela una cita pagada con el Stripe anterior
- **THEN** la cita se cancela y su pago sigue `paid`

### Requirement: Vista pública de la barbería
`GET /v1/public/tenant` SHALL exponer sin sesión: nombre, moneda, idiomas, tema, marca, sucursales activas, `payments.transfer`, `payments.online` y, con pagos en línea, la regla de anticipo y los minutos de apartado. MUST NOT exponer la suscripción, datos bancarios, ids de Stripe ni datos internos.

#### Scenario: Visitante sin sesión
- **WHEN** alguien consulta la barbería sin sesión
- **THEN** recibe esos campos y ningún dato bancario ni id de Stripe
