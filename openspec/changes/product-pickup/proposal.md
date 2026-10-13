## Why
Muchas barberías venden productos (cera, aceites, etc.) y hoy el sistema solo conoce servicios. Se necesita un módulo opcional, separado de las citas, para que el cliente aparte un producto y el staff lo entregue verificando que sea suyo.

## What Changes
- Módulo **opcional** por barbería (`products.enabled`, apagado por defecto). Apagado, ninguna ruta ni pantalla de productos existe (404).
- Catálogo de productos configurable (nombre, descripción, precio, fotos, categoría, sucursal opcional, existencias opcionales).
- El cliente con cuenta **aparta** productos (sin pago en línea) y recibe un **QR** de su apartado.
- El staff (barbero, manager, admin, owner) escanea el QR desde su teléfono en un módulo nuevo, entrega el producto y registra el cobro en **efectivo o SPEI**. Si no hay cámara, elige el apartado de una lista de pendientes.
- Los apartados vencen a los 7 días y devuelven las existencias.

## Decisions
- **Separado de las citas:** no toca `AppointmentItem`, ni totales, pagos, promociones o comisiones. Colecciones propias `products` y `productOrders`.
- **El cobro nunca pasa por el sistema:** efectivo o transferencia directa a la CLABE de la barbería; el staff solo registra el método al entregar.
- **QR sin guardar secretos:** el código es `idDelApartado.HMAC(id)` (como el token de pago de las citas); nada se guarda y no se puede adivinar con solo el id. Escanearlo muestra el apartado; entregar es una acción aparte del staff.
- **Existencias opcionales:** `stock` ausente = sin control; con control se descuenta de forma atómica al apartar (`$gte`) y se repone al cancelar o vencer.
- **Solo cuentas:** un invitado no puede apartar (el QR debe ligarse a una persona).
- Límites: 10 renglones por apartado, 3 apartados abiertos por cliente.
- Dependencias del frontend: `uqr` (generar el QR) y `jsqr` (leerlo con la cámara; Safari de iPhone no tiene `BarcodeDetector`). Ambas sin dependencias ni scripts de instalación.

## Impact
- Specs: nueva `products`; `tenancy` (interruptor y vista pública); `notifications` (tarea programada que vence apartados).
- Código: `src/features/products/`, `src/db/collections.ts`, `src/features/platform/digest.ts`, `src/app.ts`. Frontend: administración de productos, módulo "Entregas" con cámara, catálogo y "Mis apartados" con QR.
