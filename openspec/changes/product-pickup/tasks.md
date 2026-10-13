## 1. Backend
- [x] 1.1 `products.enabled` en tenant (tipo, validador, schema, vistas) y colecciones `products` y `productOrders`.
- [x] 1.2 `products/rules.ts` (renglones, total, vencimiento) y `token.ts` (código del QR) con pruebas unitarias.
- [x] 1.3 CRUD de productos (staff) y catálogo público; 404 con el módulo apagado.
- [x] 1.4 Apartar, listar, cancelar (cliente) con existencias atómicas.
- [x] 1.5 Staff: pendientes, escanear, entregar con método, cancelar.
- [x] 1.6 Vencimiento de apartados en `runScheduled`.
- [x] 1.7 Pruebas de integración `tests/products.test.ts`.

## 2. Frontend
- [x] 2.1 Interruptor del módulo en Ajustes; sección "Productos" y "Entregas" en el admin solo si está activo.
- [x] 2.2 Administración de productos.
- [x] 2.3 Módulo "Entregas": cámara (jsqr), lista de pendientes, entregar con efectivo o SPEI.
- [x] 2.4 Catálogo de productos del cliente, apartar y "Mis apartados" con QR (uqr).

## 3. Specs
- [x] 3.1 `products` nueva; `tenancy` y `notifications` actualizadas; README.
- [x] 3.2 typecheck, biome, `bun run test`, `bun run test:int`, build del frontend.
