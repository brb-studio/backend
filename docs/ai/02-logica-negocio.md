# 02 — Lógica de negocio (OpenSpec es la fuente de verdad)

> No infieras reglas desde el código. Lee el `spec.md` del capability antes de cambiar comportamiento. El código implementa; el spec manda.

## Dónde viven las reglas

- `openspec/specs/<capability>/spec.md` — 13 capabilities (abajo). Lenguaje: español, encabezados estructurales y keywords SHALL/MUST en inglés (ver `openspec/config.yaml`).
- Implementación pura (testeable sin DB): `catalog/rules.ts`, `promotions/rules.ts`, `availability/engine.ts`, `platform/commission.ts`, `billing/rules.ts`, `booking/order.ts`.
- Comandos: `openspec list --specs` · `openspec validate --specs --strict`. Cambios: `/opsx:propose` (o `openspec propose`) → código + spec en el mismo cambio.

## Mapa de capabilities (qué leer según qué vas a tocar)

| Capability | Lee este spec si vas a tocar… |
|---|---|
| `tenancy` | resolución por host, branding, branches, límites de plan, `SUBSCRIPTION_INACTIVE` (402) |
| `accounts-access` | registro/login/logout, sesiones 30d con renovación, roles owner/admin/manager/barber/customer, staff |
| `barbers-schedule` | barberos, horario semanal, breaks, `serviceIds`, link `userId`, time-off y cierres de sucursal |
| `catalog` | servicios y paquetes; duración/precio-lista siempre computados de servicios vigentes; `offers` (quién puede hacer qué) |
| `availability` | motor de slots libres, ventana de reserva, aviso mínimo, timezones por sucursal |
| `booking` | reserva pública/staff/walk-in, snapshots, cancel/reschedule, anti-doble-reserva |
| `promotions` | `percent`/`fixed`, códigos, `firstVisitOnly`, `maxRedemptions`, mejor descuento gana, `priceFor()` |
| `appointment-payments` | cobro Connect, estados de pago, reembolsos |
| `subscription-billing` | checkout/portal/webhooks Billing, plan `pro`/`lifetime`, referidos (20% amigo, 10% referidor como balance) |
| `notifications` | notificación en la transacción de reserva, SSE (change stream), Web Push (VAPID, chunks de 20) |
| `platform-dashboard` | summary/breakdown/appointments/options, comisión, payouts |
| `platform-safety` | auth separada de platform staff, seguridad cross-tenant |
| `media` | upload ≤1MB (tipo por bytes, SVG rechazado), cuota 500/tenant, 60/h por usuario |

## Invariantes que la IA debe respetar (resumen; el detalle está en cada spec)

1. **Tenancy estricta:** el tenant viene del host (`X-Forwarded-Host`), nunca del body. Sesión solo válida en el host de su tenant. Bodies estrictos: keys desconocidas = 422.
2. **Snapshots de cita:** la cita embebe nombres, duraciones, precios y términos de descuento al momento de reservar. El historial nunca lee el catálogo vivo.
3. **Precio único:** `promotions/rules.ts → priceFor()` se usa en `quote` y en `booking`. Lo cotizado = lo cobrado. Redención con `$inc` condicional en la transacción (no exceder `maxRedemptions`); cancelar la devuelve.
4. **Anti-doble-reserva:** transacción que sube `lockVersion` del barbero (WriteConflict → retry) + re-chequeo con el mismo engine de disponibilidad + índice único parcial `{ barberId, startAt }` como backstop.
5. **Catálogo computado:** el paquete guarda solo precio propio + ids ordenados (2–10, repeticiones OK). Duración y `listPriceMinor` se derivan de los servicios actuales.
6. **Comisión congelada:** `commission = totalMinor × commissionBps / 10000` redondeo half-up, solo en `platform/commission.ts`. Sin tasa configurada = `unconfigured`, nunca se paga ni se adivina. La tasa se congela en la cita al completarse o pagarse (`commission: { bps, amountMinor }`).
7. **Cuatro cifras separadas (platform):** `sales` (completed × `totalMinor`), `collected` (Stripe `paid`), `commission earned`, `paidOut`. Nunca sumar monedas distintas (un total por currency). `payoutId` en la cita evita joins.
8. **Payouts atómicos:** un payout liquida citas completas; índice único en `payouts.appointmentIds` hace imposible pagar una dos veces, aun concurrente.
9. **Referidos idempotentes:** un referido una sola vez (índice único); el crédito lleva idempotency key para que un webhook reintentado no pague doble.
10. **Suscripciones:** webhooks re-leen desde la API de Stripe y copian plan/estado/fin-de-periodo/límites al tenant. Rutas de billing saltan `requireActiveSubscription` (una tienda vencida debe poder pagar). Escrituras devuelven 402 `SUBSCRIPTION_INACTIVE` si la suscripción murió hace >7 días.
11. **Notificaciones garantizadas:** la notificación del barbero se escribe **dentro** de la transacción de reserva. Push se envía post-commit; 404/410 del push-service borra la suscripción; solo hosts push conocidos (anti-SSRF).

## Workflow de cambio de negocio (obligatorio)

1. `openspec propose` (o `/opsx:propose`) para el cambio.
2. Lee el `spec.md` afectado + la regla pura correspondiente (`rules.ts`/`engine.ts`/`commission.ts`).
3. Implementa: regla pura + test unitario (`bun run test`) primero; luego `service.ts`/`routes.ts` + test de integración (`bun run test:int`).
4. Actualiza el `spec.md` en el **mismo** cambio.
5. `openspec validate --specs --strict` + `bun run typecheck && bun run lint && bun run test`.
