# tenancy Specification

## Purpose
Cómo se identifica cada barbería (tenant) a partir del host, qué datos públicos expone, cómo se administran su marca y sus sucursales, y cómo el plan y el estado de la suscripción limitan lo que puede hacer. Código: `src/features/tenancy/`.

## Requirements

### Requirement: La barbería se resuelve solo por el host
El sistema SHALL identificar el tenant únicamente a partir del host de la petición (`X-Tenant-Host`, si no `X-Forwarded-Host`, si no `Host`; Vercel reescribe `X-Forwarded-Host` con el dominio del API): `<slug>.<PLATFORM_DOMAIN>` o el `customDomain` del tenant, ignorando el puerto. El sistema MUST NOT aceptar un tenant enviado en el cuerpo, la query o los encabezados de la petición; los cuerpos son estrictos y cualquier clave desconocida se rechaza.

#### Scenario: Subdominio de la plataforma
- **WHEN** llega `X-Forwarded-Host: elite.localhost:3000` con `PLATFORM_DOMAIN=localhost`
- **THEN** la petición se atiende en el contexto de la barbería `elite`

#### Scenario: Dominio propio
- **WHEN** el host coincide con el `customDomain` registrado de una barbería
- **THEN** la petición se atiende en el contexto de esa barbería

#### Scenario: Host desconocido
- **WHEN** el host no corresponde a ninguna barbería
- **THEN** la respuesta es 404 `TENANT_NOT_FOUND`

#### Scenario: Intento de elegir la barbería desde el cuerpo
- **WHEN** un cuerpo JSON incluye una clave como `tenantId`
- **THEN** la respuesta es 422 `VALIDATION` y no se procesa nada

### Requirement: Vista pública de la barbería
El sistema SHALL exponer en `GET /v1/public/tenant`, sin sesión: nombre, moneda, idiomas, idioma por defecto, tema, marca, sucursales activas ordenadas por nombre e indicadores `payments.transfer` (transferencias manuales habilitadas) y `payments.online` (pagos con Stripe; con él, la regla de anticipo y los minutos de apartado). El sistema MUST NOT exponer en esta vista la suscripción, los identificadores de Stripe ni datos internos.

#### Scenario: Visitante sin sesión
- **WHEN** un visitante pide la barbería pública
- **THEN** recibe solo las sucursales con `active: true` y ningún dato de facturación

### Requirement: Marca y tema por barbería
Owner y admin SHALL poder cambiar el nombre, la marca (`instagramUrl` https, `authImage`, `coverImage`) y el tema. El tema MUST usar solo los tokens `canvas, surface, card, fg, fg-muted, line, line-strong, glass, sheet, accent, accent-fg, accent-text`, cada uno con un color (hex, nombre, `rgb/hsl/oklch/oklab/color-mix(...)`) o con un par `{ light, dark }`.

#### Scenario: Token de tema desconocido o valor inseguro
- **WHEN** se envía un token fuera de la lista o un valor con `;`, `{` o comillas
- **THEN** la respuesta es 422 `VALIDATION`

### Requirement: Recordatorios activables
Owner y admin SHALL poder apagar o encender los recordatorios de cita de su barbería con `reminders.enabled` en `PATCH /v1/tenant` (encendidos por defecto); `GET /v1/tenant` lo devuelve siempre. El cuerpo es estricto.

#### Scenario: Apagar recordatorios
- **WHEN** el owner envía `{ "reminders": { "enabled": false } }`
- **THEN** la barbería deja de enviar recordatorios a sus clientes

### Requirement: Módulo de productos activable
Owner y admin SHALL poder activar el módulo de productos con `products.enabled` en `PATCH /v1/tenant` (apagado por defecto). El detalle del módulo vive en la capability `products`.

#### Scenario: Activar productos
- **WHEN** el owner envía `{ "products": { "enabled": true } }`
- **THEN** `GET /v1/public/tenant` devuelve `products: true`

### Requirement: Sucursales
Cada barbería SHALL tener una o más sucursales con slug único, nombre, dirección de 1 a 4 líneas, teléfono opcional en E.164, `mapsUrl` https opcional, hasta 12 fotos y zona horaria IANA. Owner y admin crean sucursales; un manager edita la suya, pero solo owner y admin cambian `active`. Manager y barbero solo ven su sucursal.

#### Scenario: Crear una sucursal pasando el límite del plan
- **WHEN** owner o admin crea una sucursal y la barbería ya tiene tantas sucursales activas como permite su plan
- **THEN** la respuesta es 402 `PLAN_LIMIT`

#### Scenario: Visibilidad por sucursal
- **WHEN** un manager o un barbero lista sucursales
- **THEN** solo ve la suya; owner y admin ven todas

### Requirement: Horario y reglas de reserva de una sucursal
El horario semanal MUST usar `HH:MM` con apertura menor que cierre, tener como máximo 21 intervalos y no traslapar intervalos del mismo día; los huecos son descansos. Las reglas de reserva usan estos rangos y valores por defecto:
- `slotIntervalMin`: 5–240 (15)
- `bufferMin`: 0–120 (0)
- `minNoticeMin`: 0–10080 (60)
- `windowDays`: 1–365 (14)
- `cancelNoticeMin`: 0–10080 (120)

#### Scenario: Horario que se traslapa
- **WHEN** un día tiene dos intervalos que se enciman
- **THEN** la respuesta es 422 `VALIDATION`

### Requirement: Planes y límites
Cada barbería SHALL tener un plan con límites de sucursales y barberos activos: `trial` 1/3, `basic` 1/5, `pro` 5/30, `lifetime` 50/500. La empresa que compró la app MUST estar en `lifetime`: nunca paga suscripción y ningún pago de suscripción cambia su plan.

#### Scenario: Plan lifetime
- **WHEN** se pide pagar la suscripción de una barbería `lifetime`
- **THEN** su plan, su estado y sus límites no cambian

### Requirement: Una suscripción inactiva bloquea escrituras
La suscripción SHALL considerarse inactiva cuando su estado es `canceled` o cuando pasaron más de 7 días desde `currentPeriodEnd`. Así, las escrituras del negocio (catálogo, sucursales, equipo, barberos, ausencias, promociones, fotos, citas y cobros) MUST responder 402 `SUBSCRIPTION_INACTIVE`. Las lecturas, la cancelación por el cliente y `/v1/billing` siguen funcionando, para que la barbería pueda volver a pagar.

#### Scenario: Periodo de gracia
- **WHEN** `currentPeriodEnd` fue hace 6 días y el estado no es `canceled`
- **THEN** las escrituras siguen permitidas

#### Scenario: Gracia vencida
- **WHEN** `currentPeriodEnd` fue hace 8 días
- **THEN** crear una cita responde 402 `SUBSCRIPTION_INACTIVE`, pero `GET /v1/billing` responde normalmente
