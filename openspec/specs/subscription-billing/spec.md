# subscription-billing Specification

## Purpose
La barbería le paga a la plataforma su suscripción mensual por transferencia SPEI a la cuenta del dueño del proyecto, y puede invitar a otras barberías con un código de referido. Stripe ya no interviene. Código: `src/features/billing/` (reglas puras en `rules.ts`) y la cola de confirmación en `src/features/platform/routes.ts`.

## Requirements

### Requirement: Una sola suscripción
Existe un solo precio mensual (`SUBSCRIPTION_PRICE_MINOR`, por defecto 30000 = 300.00, en `SUBSCRIPTION_CURRENCY`, por defecto MXN). Confirmar un pago SHALL poner a la barbería en el plan `pro` con sus límites y un mes más de periodo; si aún le quedaba periodo, el mes se suma a lo que quedaba. No hay cobro automático: cada mes el owner pide y transfiere otro pago. Solo el owner ve y gestiona la facturación.

#### Scenario: Admin intenta ver la facturación
- **WHEN** un admin pide `GET /v1/billing`
- **THEN** la respuesta es 403 `FORBIDDEN`

### Requirement: Cuenta que recibe
La cuenta receptora SHALL leerse de la colección `ownerProject` (documento `active` con `bankAccountKey`; `name` es el titular), que se edita a mano en la base. En cada pago, la CLABE MUST tener dígito verificador válido; si no hay cuenta válida, 503 `BILLING_DISABLED` y no se crea nada. La cuenta se copia al pago, así que editarla no altera pagos ya pedidos.

#### Scenario: CLABE del proyecto mal escrita
- **WHEN** el owner pide pagar y `ownerProject.bankAccountKey` no pasa la validación
- **THEN** la respuesta es 503 `BILLING_DISABLED`

### Requirement: Pedir el pago
`POST /v1/billing/payment` con `{ referralCode? }` SHALL crear un pago `pending` con importe = precio de lista − descuento de referido (solo primer mes) − crédito disponible, todo calculado en el servidor; pedirlo otra vez mientras sigue pendiente devuelve el mismo. Vence a los 5 días (`expired`). Si el crédito cubre todo el mes, el pago MUST nacer `paid` sin transferencia.

#### Scenario: Barbería lifetime
- **WHEN** una barbería con plan `lifetime` pide pagar
- **THEN** la respuesta es 409 `LIFETIME_PLAN`

#### Scenario: Demasiados intentos
- **WHEN** la barbería pide pagar más de 10 veces en una hora
- **THEN** la respuesta es 429 `RATE_LIMITED`

### Requirement: Confirmar el pago
Solo el staff de plataforma SHALL listar (`GET /platform/subscriptions?status=`), confirmar (`POST /platform/subscriptions/:id/confirm` con `receivedMinor` igual al importe y `reference?`) y rechazar (`.../reject`). Confirmar MUST actualizar en una transacción el pago, el plan, el periodo, el crédito gastado y la recompensa de referido; confirmar de nuevo es 409 `INVALID_TRANSITION`.

#### Scenario: Confirmación por el staff
- **WHEN** el staff confirma el importe exacto de un pago pendiente
- **THEN** la barbería queda `pro` y `active` con un mes más y recibe su código de referido

#### Scenario: El owner no puede confirmarse a sí mismo
- **WHEN** un owner llama a una ruta de `/platform`
- **THEN** no es staff de plataforma y la respuesta es 401, 403 o 404

#### Scenario: Importe incorrecto
- **WHEN** se confirma con un `receivedMinor` distinto al importe
- **THEN** la respuesta es 422 `AMOUNT_MISMATCH` y nada cambia

### Requirement: Datos históricos de Stripe
Los campos `billing.stripeCustomerId`, `billing.stripeSubscriptionId` y `billing.cancelAt`, y los referidos con `checkoutSessionId`, MUST conservarse sin cambios aunque nada los use. La recompensa de referidos antiguos que Stripe guardó como saldo no se migra.

#### Scenario: Barbería con suscripción antigua de Stripe
- **WHEN** una barbería con `billing.stripeSubscriptionId` paga por transferencia
- **THEN** ese campo se conserva sin cambios

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
Cuando plataforma confirma el primer mes pagado de la barbería invitada, la que invitó SHALL recibir un crédito del 10% del precio de lista de ese mes en `billing.creditMinor`, que se descuenta solo de sus próximos pagos (se acumula). El crédito MUST NOT duplicarse: confirmar es una transición única y hay un solo referido por barbería invitada (índice único).

#### Scenario: Confirmación repetida
- **WHEN** se confirma dos veces el primer pago de la barbería invitada
- **THEN** la segunda respuesta es 409 `INVALID_TRANSITION` y la que invitó recibe un solo crédito
