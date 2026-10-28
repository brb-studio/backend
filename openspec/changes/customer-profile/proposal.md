## Why
La LFPDPPP da al titular el derecho de rectificación (ARCO). Hoy un cliente no puede corregir su nombre ni su teléfono: solo puede borrar su cuenta, y para corregir tendría que pedirlo en la sucursal.

## What Changes
- `PATCH /v1/auth/me` (solo `customer`): `{ name, phone }`, ambos obligatorios; `phone: ""` lo quita. Mismas reglas que el registro.
- Si la cuenta tiene Customer de Stripe, se corrige primero ahí (nombre y teléfono); si Stripe falla, 502 y no cambia nada.
- Frontend: "Mis datos" en Cuenta, solo para clientes.

## Decisions
- **Sin correo.** Cambiarlo exige verificar la dirección nueva antes de usarla para iniciar sesión; queda para otro cambio.
- **Sin contraseña.** Nombre y teléfono no dan acceso a nada; pedirla solo estorba.
- **Stripe primero**, igual que al borrar la cuenta, para no dejar en Stripe un dato que el titular ya corrigió.
- **Solo clientes.** Los datos del personal los edita el dueño en Equipo.

## Impact
- Specs: `accounts-access` (requisito "Corregir los datos propios").
- Código: `src/features/auth/profile.ts`, `routes.ts`, `schemas.ts`; `tests/customers.test.ts`, `tests/stripe-fake.ts`.
