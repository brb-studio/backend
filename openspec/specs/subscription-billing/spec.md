# subscription-billing Specification

## Purpose
La barbería le paga a la plataforma su suscripción mensual (Stripe Billing, en la cuenta de la plataforma) y puede invitar a otras barberías con un código de referido. Código: `src/features/billing/` (reglas puras en `rules.ts`).

## Requirements

### Requirement: Una sola suscripción
Existe un solo precio mensual, configurado en Stripe (`STRIPE_SUBSCRIPTION_PRICE`). Pagarlo SHALL poner a la barbería en el plan `pro` con sus límites. Solo el owner ve y gestiona la facturación. Sin precio configurado, la facturación responde 503 `BILLING_DISABLED`.

#### Scenario: Admin intenta ver la facturación
- **WHEN** un admin pide `GET /v1/billing`
- **THEN** la respuesta es 403 `FORBIDDEN`

### Requirement: Contratar y administrar
El owner SHALL iniciar el pago en Stripe Checkout y administrar su suscripción en el portal de Stripe. La URL de regreso MUST pertenecer al sitio de esa misma barbería (en producción, https); si no, 422 `VALIDATION`. Así el pago no puede usarse para redirigir a otro sitio.

#### Scenario: URL de regreso ajena
- **WHEN** el owner envía `returnUrl: https://otro-sitio.com`
- **THEN** la respuesta es 422 `VALIDATION`

### Requirement: Cuándo no se puede contratar
El sistema MUST rechazar estos casos:
- Una barbería `lifetime` quiere pagar: 409 `LIFETIME_PLAN`.
- La suscripción sigue cobrando: 409 `ALREADY_SUBSCRIBED`, para no cobrar dos veces.
- Se abre el portal sin nada pagado: 409 `NO_BILLING_ACCOUNT`.
- Hubo más de 10 intentos de checkout en una hora: 429 `RATE_LIMITED`.

#### Scenario: La empresa compradora intenta pagar
- **WHEN** el owner de una barbería `lifetime` inicia el checkout
- **THEN** la respuesta es 409 `LIFETIME_PLAN`

### Requirement: Estado sincronizado desde Stripe
Ante cada evento de suscripción, el sistema SHALL volver a leer la suscripción desde Stripe en lugar de confiar en el contenido del evento, y guardar su estado, el fin del periodo y la cancelación programada. Una suscripción vieja ya terminada MUST NOT sobrescribir a la que la reemplazó.

#### Scenario: Cancelación desde el portal
- **WHEN** el owner cancela desde el portal y el periodo pagado termina el día 30
- **THEN** la barbería sigue `active` hasta el día 30 y queda guardado `cancelAt`

#### Scenario: Eventos fuera de orden
- **WHEN** un evento viejo de una suscripción cancelada llega después de que la barbería contrató una nueva
- **THEN** el estado de la suscripción nueva no cambia

### Requirement: Traducción de estados de Stripe
El estado de Stripe SHALL traducirse así:
- `active` → `active`;
- `trialing` → `trialing`;
- `past_due`, `unpaid` o `paused` → `past_due`;
- `canceled` o `incomplete_expired` → `canceled`.

Cualquier otro estado (por ejemplo, el primer pago todavía pendiente) MUST NOT cambiar nada.

#### Scenario: Pago atrasado
- **WHEN** Stripe marca la suscripción como `unpaid`
- **THEN** la barbería queda `past_due`

### Requirement: Códigos de referido
Una barbería que ya pagó al menos una vez SHALL tener un código de 8 símbolos sin `I`, `O`, `0` ni `1`, para que no se confundan al dictarlos o leerlos. Al escribirlo, se ignoran mayúsculas, espacios y guiones. La validación de códigos se limita a 20 intentos por hora.

#### Scenario: Código escrito a mano
- **WHEN** alguien escribe `7k3m-9qx2`
- **THEN** se valida como `7K3M9QX2`

### Requirement: Uso de un código de referido
Un código SHALL dar 20% de descuento en el primer mes pagado de la barbería invitada. Aplica una sola vez por barbería, solo en su primer mes y nunca a sí misma, es decir, ni en la misma barbería ni con el mismo correo de owner.

#### Scenario: Usar el propio código
- **WHEN** una barbería usa el código de otra cuyo owner tiene el mismo correo
- **THEN** la respuesta es 409 `REFERRAL_SELF`

#### Scenario: Código después del primer pago
- **WHEN** una barbería que ya pagó antes intenta usar un código
- **THEN** la respuesta es 409 `REFERRAL_NOT_FIRST`

### Requirement: Crédito para quien invita
Cuando la barbería invitada paga su primer mes, la que invitó SHALL recibir un crédito del 10% del precio de lista de ese mes, que Stripe descuenta solo de sus próximas facturas. Los reintentos de webhook MUST NOT duplicarlo: hay un solo referido por barbería invitada y el crédito se crea con llave de idempotencia.

#### Scenario: Webhook repetido
- **WHEN** Stripe envía dos veces el evento del primer pago de la barbería invitada
- **THEN** la barbería que invitó recibe un solo crédito
