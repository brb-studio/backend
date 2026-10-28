# fiscal Specification

## Purpose
Funciones fiscales opcionales por barbería: IVA incluido en los precios y facturas electrónicas (CFDI) que el cliente pide y la barbería emite en su propio sistema. Ninguna de las dos está activa salvo que la barbería la encienda. Código: `src/features/fiscal/`, más `iva` e `invoicing` en `tenants` y `invoiceRequests`.

## Requirements

### Requirement: Funciones fiscales apagadas por defecto
Una barbería nueva SHALL tener el IVA y la facturación apagados. Solo el owner y el admin pueden encenderlos o cambiar sus datos con `PATCH /v1/tenant`. Cuando están apagados, las respuestas MUST NOT incluir desgloses de IVA ni la facturación MUST NOT aceptar solicitudes.

#### Scenario: Barbería sin funciones fiscales
- **WHEN** un cliente pide una factura en una barbería con la facturación apagada
- **THEN** la respuesta es 409 `INVOICING_DISABLED` y no se crea nada

#### Scenario: Historial sin IVA encendido
- **WHEN** un cliente consulta sus citas en una barbería con IVA apagado
- **THEN** ninguna cita trae el campo `iva`

### Requirement: IVA incluido en el precio
Cuando la barbería enciende `iva`, SHALL declarar que sus precios ya incluyen IVA al 16 %. El desglose se calcula en el servidor (`ivaIncluded`): la base es el total entre 1.16 redondeado a la unidad menor más cercana, y el IVA es el total menos la base, de modo que base + IVA siempre suma el total que pagó el cliente. El cobro, los reembolsos y las comisiones MUST NOT cambiar por esta función.

#### Scenario: Desglose de una cita
- **WHEN** una cita de 116.00 MXN se consulta con IVA encendido
- **THEN** `iva.baseMinor` es 10000, `iva.ivaMinor` es 1600 y ambos suman el `totalMinor`

#### Scenario: Encender IVA no mueve montos
- **WHEN** la barbería enciende IVA
- **THEN** los totales, cobros y comisiones de las citas existentes quedan igual

### Requirement: Datos fiscales de la barbería
Con `invoicing.enabled`, la barbería SHALL guardar RFC, razón social, régimen fiscal (3 dígitos) y código postal (5 dígitos). El RFC MUST cumplir el formato de persona moral (12 caracteres) o física (13 caracteres); si no, 422 `VALIDATION`. Todos los campos se envían juntos en cada cambio.

#### Scenario: RFC inválido
- **WHEN** el owner guarda un RFC que no cumple el formato
- **THEN** la respuesta es 422 y no cambia nada

### Requirement: Solicitud de factura del cliente
Un cliente con cuenta SHALL poder pedir una factura con `POST /v1/me/appointments/:id/invoice` para una cita suya en estado `completed`, con sus datos fiscales (RFC, nombre, régimen, código postal y uso del CFDI). El importe y la moneda salen de la cita en la base de datos, nunca del cuerpo. Una cita solo puede tener una solicitud (409 `INVOICE_ALREADY_REQUESTED`). Una cita que no está completada responde 409 `NOT_COMPLETED`, y una cita ajena responde 404.

#### Scenario: Pedir factura de una visita completada
- **WHEN** el cliente pide factura de su visita completada con datos válidos
- **THEN** la respuesta es 201 con `status: requested` y el importe de la cita

#### Scenario: Pedirla dos veces
- **WHEN** el cliente pide factura de una visita que ya tiene solicitud
- **THEN** la respuesta es 409 `INVOICE_ALREADY_REQUESTED`

### Requirement: Cola de facturas de la barbería
El owner y el admin SHALL ver todas las solicitudes con `GET /v1/invoices` (más antiguas primero) y cerrarlas con `PATCH /v1/invoices/:id`: `issued` con el UUID del CFDI que emitieron en su sistema, o `cancelled`. Una solicitud solo se cierra una vez (409 `INVOICE_CLOSED`). El sistema MUST NOT timbrar el CFDI: la emisión y la cancelación ante el SAT ocurren fuera de la app, y aquí solo se registran. Los demás roles reciben 403.

#### Scenario: Marcar como emitida
- **WHEN** el admin marca una solicitud como `issued` con un UUID válido
- **THEN** la solicitud queda `issued` con ese UUID y la fecha de emisión

#### Scenario: Emitida sin UUID
- **WHEN** se marca `issued` sin `cfdiUuid`
- **THEN** la respuesta es 422 y la solicitud sigue `requested`

#### Scenario: Cerrar dos veces
- **WHEN** se intenta cerrar una solicitud ya `issued` o `cancelled`
- **THEN** la respuesta es 409 `INVOICE_CLOSED`

### Requirement: Consultar mis facturas
El cliente SHALL poder listar sus solicitudes con `GET /v1/me/invoices` (las más recientes primero, hasta 50). No ve las de otros clientes.

#### Scenario: Estado de mi factura
- **WHEN** el cliente consulta sus facturas después de que la barbería la marcó `issued`
- **THEN** la solicitud aparece con `status: issued` y su UUID
