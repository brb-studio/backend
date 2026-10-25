## Why
Revisión de seguridad (H5): `GET /v1/customers` dejaba a un manager listar a todos los clientes de la barbería (nombre, teléfono, correo), aunque solo atiende una sucursal; sin límite de peticiones, el tope de 50 se podía saltar enumerando búsquedas.

## What Changes
- Un manager solo ve a los clientes con al menos una cita (cualquier estado) en su sucursal. Owner y admin siguen viendo a todos.
- Límite de 60 listados/búsquedas por usuario cada 10 minutos; después 429 `RATE_LIMITED` (contador compartido de `db/rate-limit.ts`).

## Decisions
- **Ids por cursor plano:** un `find` de citas de la sucursal con `.project({ customerId: 1 })` (índice `tenant_branch_start`), deduplicado en JS, y luego `_id: { $in }` en la búsqueda de clientes. Sin `aggregate`, sin `$lookup`, sin `toArray`.
- **Cualquier estado cuenta:** una cita cancelada o `pending_payment` también es una relación con la sucursal, porque el manager pudo haberla atendido o agendado.
- **Clave por usuario** (`customers:<userId>`): el endpoint exige sesión de staff; 60 cada 10 minutos sobra para la búsqueda por envío del panel.
- Reemplaza la decisión "Manager: ve a todos los clientes" de `customer-list`.

## Impact
- Specs: `booking` (requisito "Lista de clientes").
- Código: `src/features/customers/service.ts`; `tests/customers.test.ts`.
