# products Specification

## Purpose
Módulo opcional para las barberías que venden productos (cera, aceites, etc.): el cliente con cuenta aparta productos sin pagar en línea, recibe un QR, y el staff lo escanea con su teléfono, entrega el producto y registra el cobro en efectivo o por transferencia SPEI. Es independiente de las citas. Código: `src/features/products/`.

## Requirements

### Requirement: Módulo activable por barbería
Owner y admin SHALL poder activar o desactivar el módulo con `products.enabled` en `PATCH /v1/tenant` (apagado por defecto); `GET /v1/tenant` lo devuelve siempre y `GET /v1/public/tenant` lo expone como `products: true|false`. Con el módulo apagado, todas las rutas de productos (`/v1/products`, `/v1/public/products`, `/v1/me/product-orders`, `/v1/product-orders`) MUST responder 404.

#### Scenario: Módulo apagado
- **WHEN** una barbería sin el módulo recibe `GET /v1/public/products`
- **THEN** la respuesta es 404

### Requirement: Catálogo de productos
Un producto SHALL tener slug único por barbería, nombre en es o en (máximo 80 caracteres), descripción opcional (máximo 500), precio entero en unidades menores de 0 a 10,000,000, categoría opcional (máximo 40), hasta 12 fotos, posición y, opcionalmente, una sucursal (sin ella se vende en todas). Las existencias son opcionales: sin `stock` el producto no se cuenta y nunca se agota. Owner y admin crean y editan; un producto no se borra, se desactiva con `active: false`. Enviar `stock: null` o `category: null` quita el valor. Un slug repetido responde 409 `SLUG_TAKEN`; un barbero o manager que intenta crear responde 403.

#### Scenario: Dejar de contar existencias
- **WHEN** el owner envía `{ "stock": null }` a un producto con existencias
- **THEN** el producto deja de tener `stock` y ya no se agota

### Requirement: Catálogo público
`GET /v1/public/products` SHALL devolver los productos activos (con `?branch=` solo los de esa sucursal y los de todas), ordenados por posición y slug, con `available` pero MUST NOT revelar cuántas unidades quedan.

#### Scenario: Producto agotado
- **WHEN** un producto con existencias llega a 0
- **THEN** el catálogo público lo muestra con `available: false`

### Requirement: Apartar productos
Un cliente con cuenta SHALL poder apartar con `POST /v1/me/product-orders` productos activos para recogerlos en una sucursal activa: de 1 a 10 renglones, de 1 a 20 unidades por renglón (un producto repetido se suma). El apartado guarda nombre y precio tal como se mostraron y el total en unidades menores, y vence a los 7 días. Un invitado (sin sesión) recibe 401. Un producto desconocido o inactivo, o de otra sucursal, responde 422; no se pueden tener más de 3 apartados abiertos (409 `TOO_MANY_RESERVATIONS`). Nada se cobra en línea.

#### Scenario: Apartar con existencias
- **WHEN** un cliente aparta 2 unidades de un producto con 2 en existencia
- **THEN** el apartado queda `reserved` y el producto queda en 0

### Requirement: Existencias sin sobreventa
Con existencias contadas, apartar SHALL descontar las unidades de forma atómica en la misma transacción que crea el apartado; si no alcanzan, la respuesta es 409 `OUT_OF_STOCK` y no cambia nada. Cancelar o vencer un apartado abierto MUST devolver las unidades (solo a productos que siguen contándose); un apartado ya entregado o cerrado no devuelve nada.

#### Scenario: Dos clientes, una unidad
- **WHEN** dos clientes apartan la última unidad
- **THEN** uno recibe 201 y el otro 409 `OUT_OF_STOCK`

### Requirement: Mis apartados y QR
`GET /v1/me/product-orders` SHALL listar los últimos 20 apartados del cliente, con sucursal, renglones, total, estado (`reserved`, `delivered`, `cancelled`, `expired`) y vencimiento, y los datos de transferencia de la barbería (`transfer`) solo si acepta transferencias. Cada apartado abierto MUST traer un `code` (el id y su HMAC): el contenido del QR. El código no se guarda, y un id sin HMAC o con un HMAC distinto no sirve. El cliente puede cancelar su apartado abierto con `POST /v1/me/product-orders/:id/cancel`; el de otro cliente responde 404 y uno cerrado 409 `NOT_RESERVED`.

#### Scenario: Apartado entregado
- **WHEN** el staff entrega un apartado
- **THEN** el cliente lo ve `delivered` sin `code`

### Requirement: Escanear y entregar
El staff (owner, admin, manager y barbero) SHALL ver los apartados abiertos de sus sucursales (`GET /v1/product-orders`, owner y admin ven todas), escanear un código con `POST /v1/product-orders/scan` (devuelve el apartado con nombre y teléfono del cliente; leerlo no cambia nada) y entregar con `POST /v1/product-orders/:id/deliver` indicando `method`: `cash` o `spei`. Entregar marca el apartado `delivered` y guarda método, quién cobró y cuándo, una sola vez (409 `NOT_RESERVED` si ya no está abierto). Un código inválido o de otra sucursal del staff responde 404. El sistema MUST NOT mover dinero: el cliente paga en efectivo o por transferencia a la CLABE de la barbería, y el staff solo registra cómo. El staff también puede cancelar un apartado abierto.

#### Scenario: Código falsificado
- **WHEN** el staff escanea un código con el id de un apartado pero sin su HMAC válido
- **THEN** la respuesta es 404

#### Scenario: Entregar dos veces
- **WHEN** dos miembros del staff entregan el mismo apartado
- **THEN** el primero recibe 200 y el segundo 409 `NOT_RESERVED`

### Requirement: Apartados que vencen
Con las tareas programadas, los apartados abiertos cuyo vencimiento pasó SHALL pasar a `expired` y devolver sus unidades, una sola vez, aunque corran varias instancias a la vez. Solo corre para barberías con el módulo activo.

#### Scenario: Nadie pasa por el apartado
- **WHEN** pasan 7 días sin que se entregue un apartado y corren las tareas programadas
- **THEN** queda `expired` y el producto recupera sus unidades
