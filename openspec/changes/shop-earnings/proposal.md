## Why
Los dueños quieren saber cuánto entró hoy, la semana pasada o el mes, sin sacar la calculadora. Hoy solo existe "Pagos a barberos" (comisiones de un día por barbero) y el "Ingresos esperados hoy" del inicio, que cuenta citas aún no hechas.

## What Changes
- Endpoint `GET /v1/earnings/summary?from&to` (owner/admin): cortes completados, productos entregados, comisión de barberos y total bruto por día.
- Sección nueva **Ganancias** en el admin (owner/admin), también en la barra inferior del teléfono: periodos Hoy · Ayer · Esta semana · Semana pasada · Este mes · Mes pasado; tarjetas Ingresos, "Te queda tras comisiones" (solo si hay comisiones) y Cortes completados con ticket promedio; una gráfica de barras por día cuando el periodo tiene más de un día.

## Decisions
- **Ingresos = cortes completados + productos entregados.** Lo que aún no pasa (citas confirmadas, apartados) no cuenta.
- **Ganancia = ingresos − comisiones de barberos.** No hay gastos en el sistema (renta, insumos), así que no se inventa un "profit" real.
- **Una moneda:** la de la barbería, que no cambia después de crearla.
- **Sin librería de gráficas:** barras con CSS; tocar o pasar el cursor por una barra muestra su día e importe.
- Fuera por ahora: comparar con el periodo anterior, filtro por sucursal, rango libre de fechas.

## Impact
- Specs: `platform-dashboard` (requisito "Ganancias de la propia barbería").
- Código: `src/features/platform/revenue.ts`, `tenant-routes.ts`, `schemas.ts`; `localDate` pasa a `src/shared/time.ts`. Frontend: `features/admin/revenue.tsx`, `periods.ts`, página `admin/revenue`, sección y textos.
