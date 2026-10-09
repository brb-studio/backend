# appointment-payments Specification

## Purpose
Cobro en línea de las citas, hecho en la cuenta de Stripe Connect de cada barbería (el dinero es de la barbería; la plataforma puede cobrar una comisión). Código: `src/features/payments/`.

## Requirements

### Requirement: Conectar la cuenta de cobro
Owner y admin SHALL poder crear la cuenta Connect de su barbería y obtener el enlace de alta (requiere `FRONTEND_URL`; sin él, 503 `PAYMENTS_DISABLED`). El estado de la cuenta (`detailsSubmitted`, `chargesEnabled`) MUST leerse de Stripe y guardarse en la barbería, tanto al consultarlo como al llegar las notificaciones de la cuenta. Todo el staff puede ver ese estado.

#### Scenario: Barbería sin Stripe configurado en el servidor
- **WHEN** el servidor no tiene llaves de Stripe
- **THEN** el estado responde `connected: false` y cobrar responde 503 `PAYMENTS_DISABLED`

### Requirement: Pagar una cita
`POST /v1/public/payments/intent` SHALL crear (o reutilizar, si sigue pendiente) un PaymentIntent por el total congelado de una cita confirmada, en la moneda de la barbería y sobre su cuenta Connect. La comisión de la plataforma es `STRIPE_APP_FEE_BPS` puntos base, redondeada hacia abajo.

#### Scenario: Reintento del mismo pago
- **WHEN** el cliente vuelve a pedir el pago de una cita cuyo intento sigue pendiente
- **THEN** recibe el mismo intento, no uno nuevo

### Requirement: Cuándo no se puede cobrar
El cobro MUST rechazarse en estos casos:
- La barbería no tiene los cobros habilitados: 409 `STRIPE_NOT_CONNECTED`.
- La cita tiene total 0: 422 `NOTHING_TO_CHARGE`.
- La cita ya está pagada: 409 `ALREADY_PAID`.
- Hubo más de 30 intentos en 10 minutos desde la misma IP y barbería: 429 `RATE_LIMITED`.

#### Scenario: Cita ya pagada
- **WHEN** se pide pagar una cita con pago `paid`
- **THEN** la respuesta es 409 `ALREADY_PAID`

### Requirement: Solo quien reservó puede pagar
Un invitado SHALL demostrar que hizo la reserva con el `paymentToken` que recibió al reservar: un HMAC del id de la cita, que no se guarda y se compara en tiempo constante. Un cliente con sesión solo MUST poder pagar sus propias citas. En cualquier otro caso la respuesta es 404 `NOT_FOUND`, porque un id de cita solo se puede adivinar.

#### Scenario: Id ajeno sin token
- **WHEN** un invitado pide pagar una cita con un id válido pero sin token o con un token incorrecto
- **THEN** la respuesta es 404 `NOT_FOUND`

### Requirement: Estado del pago por webhooks firmados
`POST /webhooks/stripe` SHALL aceptar solo eventos con firma válida (sin firma o con firma incorrecta, 400 `BAD_SIGNATURE`). El estado de pago de la cita cambia así:
- `requires_payment` → `paid` (pago exitoso);
- `requires_payment` → `failed` (pago fallido o cancelado);
- `paid` → `refunded` (reembolso).

Si un manejador falla, la respuesta MUST ser un error 5xx, para que Stripe reintente.

#### Scenario: Evento falsificado
- **WHEN** llega un evento `payment_intent.succeeded` sin firma válida
- **THEN** la respuesta es 400 `BAD_SIGNATURE` y ninguna cita cambia

### Requirement: Reembolsos
Owner, admin y manager SHALL poder reembolsar una cita pagada; si no está pagada, la respuesta es 409 `NOT_PAID`. Cancelar una cita pagada (por el cliente o por el staff) MUST pedir el reembolso automáticamente. Si el reembolso automático falla, la cancelación se mantiene y el error queda registrado.

#### Scenario: Cliente cancela una cita pagada
- **WHEN** un cliente cancela a tiempo una cita pagada en línea
- **THEN** la cita queda cancelada y su pago pasa a `refunded`
