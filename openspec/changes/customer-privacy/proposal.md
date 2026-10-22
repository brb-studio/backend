## Why
La LFPDPPP (nueva ley, DOF 20-03-2025) pide un aviso de privacidad (art. 15), su versión simplificada donde se recaban datos por medios electrónicos (art. 16 II) y que el titular pueda cancelar sus datos (arts. 24, 25 y 31). Hoy guardamos nombre, correo y teléfono de los clientes sin aviso y sin forma de borrar la cuenta.

## What Changes
- `POST /v1/auth/delete-account` (solo `customer`): con la contraseña, borra los datos de contacto y el acceso de la cuenta, y vacía el Customer de Stripe. Rechaza con 409 `OPEN_BOOKINGS` mientras haya citas futuras, pagos en curso o productos apartados.
- `users.deletedAt` (opcional) y una tercera rama del validador: un cliente borrado no tiene correo ni contraseña y no es invitado.
- `scope().deleteMany` en `db/scoped.ts`.
- `POST /v1/auth/register` exige `acceptTerms: true` y guarda `users.termsAcceptedAt`: la prueba del consentimiento (art. 8). El frontend lo pide en un drawer inferior al abrir el registro.
- Frontend: página `/{lang}/privacy` con el aviso integral, aviso simplificado bajo el registro y "Borrar mi cuenta" en Cuenta.

## Decisions
- **Anonimizar, no borrar el documento.** Las citas y apartados pasados siguen apuntando al registro sin datos, así los reportes, comisiones y pagos a barberos no cambian. El art. 25 I permite conservar lo necesario para la relación ya cumplida.
- **Bloquear con pendientes** en lugar de cancelar citas o reembolsar en automático: evita lógica de dinero en el borrado y la barbería conserva el contacto mientras la cita sigue viva.
- **Stripe primero:** si vaciar el Customer falla, no se toca la base, para no perder la referencia y poder reintentar.
- **El responsable es la barbería**, con domicilio en sus sucursales; el medio para los demás derechos ARCO es la sucursal (en persona o por teléfono). No hay campo de correo de privacidad ni razón social todavía.
- **Invitados** (sin cuenta) no pueden borrarse solos: lo piden en la sucursal.

## Impact
- Specs: `accounts-access` (requisito "Borrar la cuenta propia").
- Código: `src/features/auth/erase.ts`, `routes.ts`, `schemas.ts`; `src/db/collections.ts`, `src/db/scoped.ts`; `tests/customers.test.ts`.
