## Why
Cuando un cliente llama o llega, el equipo no tiene dónde ver quién es: cuántas veces vino, si falta, cuánto ha gastado y cuándo vuelve. Estaba pendiente desde el BREAKPOINT del 3 de octubre.

## What Changes
- `GET /v1/customers?q=` (owner, admin, manager): hasta 50 clientes, los más nuevos o los que coinciden con la búsqueda, con visitas, faltas, gasto, última visita y próxima cita.
- Sección nueva **Clientes** en el panel (owner, admin, manager), en el grupo "Día a día", con buscador.

## Decisions
- **Cursores planos, sin `aggregate`:** un `find` de clientes limitado a 50 y otro de sus citas por `tenant_customer_start`, sumando en JS (`customers/rules.ts`).
- **Teléfono por dígitos:** los teléfonos se guardan sin espacios ni guiones, así que una búsqueda solo de caracteres de teléfono compara dígitos.
- **Regex sin ancla:** recorre los clientes de la barbería; si alguna pasa de ~50 mil, conviene un índice de texto. Los acentos tienen que coincidir.
- **Manager:** ve a todos los clientes de la barbería, pero sus números solo cuentan su sucursal.
- **Gasto = cortes completados**, igual que Ganancias; los productos entregados no cuentan.
- Fuera por ahora: ficha del cliente con su historial, notas, editar datos, paginación.

## Impact
- Specs: `booking` (requisito "Lista de clientes").
- Código: `src/features/customers/` (`routes.ts`, `service.ts`, `rules.ts` con prueba), `src/app.ts`; `tests/customers.test.ts`. Frontend: `features/admin/customers.tsx`, página `admin/customers`, sección, ruta del proxy y textos.
