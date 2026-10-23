## Why
Queremos rentar el sistema también a barberías de una sola persona, donde el dueño es el barbero. El backend ya permitía vincular un perfil de barbero a la cuenta del dueño, pero en la interfaz había que crear el perfil, abrir "Editar" y buscar la cuenta en una lista; un perfil nuevo además empezaba sin servicios y nadie podía reservar con él.

## What Changes
- `POST /v1/barbers/me` (owner/admin): crea el perfil propio vinculado, con todos los servicios y el horario de la sucursal.
- Mi día (owner/admin sin perfil): tarjeta "¿También atiendes clientes?" con "Sí, yo también atiendo", selector de sucursal si hay varias y "Soy yo: {nombre}" para vincular un perfil que ya exista.
- Barberos: la misma tarjeta arriba mientras el dueño no tenga perfil; cada perfil dice su cuenta ("Tu cuenta", "Cuenta: Ana", "Sin cuenta"); al crear un barbero se elige su cuenta y empieza con todos los servicios de su sucursal.

## Decisions
- **El dueño sigue siendo dueño:** el perfil solo agrega Mi día, sus citas y sus avisos; los permisos no cambian.
- **Manager no puede ser barbero** (regla ya existente de la cuenta vinculada); solo owner y admin usan el atajo.
- **Sin plan nuevo todavía:** una barbería de una persona cabe en cualquier plan; un plan "Solo" más barato es una decisión de precio pendiente.

## Impact
- Specs: `barbers-schedule` (cuenta vinculada).
- Código: `src/features/barbers/{self,routes,schemas}.ts`; pruebas `self.test.ts`, `tests/self-barber.test.ts`. Frontend: `become-barber.tsx`, `my-day.tsx`, `barbers-manager.tsx`, páginas de Mi día y Barberos, ruta `barbers/me` del proxy y textos.
