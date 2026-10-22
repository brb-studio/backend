# platform-dashboard Specification

## Purpose
Panel global del staff de la plataforma: supervisar todas las barberías, sus sucursales y barberos, con ingresos, comisiones y pagos separados y trazables por corte. Código: `src/features/platform/`.

## Requirements

### Requirement: Acceso solo para staff de la plataforma
Las rutas `/platform/*` (salvo el inicio de sesión) SHALL aceptar únicamente la sesión de una cuenta activa de `platformStaff`. Un token de barbería MUST NOT valer aquí ni un token de plataforma en `/v1`. Las sesiones duran 12 horas y no se renuevan. Los intentos de inicio de sesión se limitan a 10 por correo y 30 por IP cada 15 minutos.

#### Scenario: Dueño de una barbería
- **WHEN** el dueño de una barbería llama a `/platform/summary` con su token
- **THEN** la respuesta es 401 `UNAUTHENTICATED`

#### Scenario: Cuenta desactivada
- **WHEN** una cuenta de staff se desactiva
- **THEN** su token deja de funcionar en la siguiente petición

### Requirement: Ingresos, ventas, comisiones y pagos por separado
El resumen SHALL devolver, por moneda y nunca sumando monedas distintas: `sales` (suma de `totalMinor` de cortes completados), `collected` (pagos en línea con estado `paid`), `commission` (devengada), `paidOut` y `pending` (= devengada − pagada). Las fechas `from`/`to` MUST ser fechas locales de cada cita (zona de su sucursal), con un máximo de 366 días.

#### Scenario: Corte cancelado
- **WHEN** hay un corte cancelado en el periodo
- **THEN** no suma a ventas ni a comisión, y se cuenta en `cancelled`

### Requirement: Comisión sin porcentajes inventados
La comisión de un corte completado SHALL ser `totalMinor × bps / 10000` redondeado hacia arriba en la mitad, donde `bps` es el porcentaje congelado en la cita o, si no lo tiene, el `commissionBps` actual del barbero. Sin ninguno, el corte MUST contarse en `unconfigured` y no devengar comisión ni poder pagarse (409 `COMMISSION_NOT_CONFIGURED`). Al completar una cita el porcentaje del barbero SHALL congelarse en ella.

#### Scenario: Cambio de porcentaje posterior
- **WHEN** se completa un corte con 50 % y luego el barbero pasa a 10 %
- **THEN** ese corte conserva 50 %

### Requirement: Pagos a barberos sin duplicados
Un pago SHALL liquidar cortes completados enteros de un mismo barbero; su importe es la suma de sus comisiones, calculada por el servidor, que las congela. Una cita MUST pertenecer como máximo a un pago (índice único); intentar pagarla otra vez responde 409 `ALREADY_PAID`. Citas de otro barbero o barbería responden 409 `INVALID_APPOINTMENTS`.

#### Scenario: Pagar dos veces
- **WHEN** se paga un corte ya incluido en un pago anterior
- **THEN** la respuesta es 409 `ALREADY_PAID` y no se crea ningún pago

### Requirement: Trazabilidad por corte
El detalle de un corte SHALL mostrar cliente, servicios, descuento, precio cobrado, pago, comisión (porcentaje, base, importe y si viene de la cita o de la configuración actual) y el pago al barbero con su fecha y referencia.

#### Scenario: Corte con comisión ya pagada
- **WHEN** el staff abre un corte completado cuya comisión se liquidó
- **THEN** ve el porcentaje congelado en la cita, el importe y el pago al barbero con su fecha y referencia

### Requirement: Ganancias de la propia barbería
El owner y el admin SHALL ver lo que entró a su barbería en un rango de días locales (máximo 366): cortes completados (`servicesMinor` y su número `cuts`), productos entregados (`productsMinor`, por el día de su cobro en la zona de su sucursal) y la comisión de los barberos sobre esos cortes (`commissionMinor`, con las mismas reglas que "Comisión sin porcentajes inventados"), más el total bruto de cada día del rango (días sin ventas en 0). La barbería sale siempre de la sesión y solo se suman importes en su moneda. Cortes cancelados, citas por pagar y apartados sin entregar MUST NOT sumar.

#### Scenario: Día con un corte y un producto
- **WHEN** hoy se completa un corte de 300.00 de un barbero al 25 % y se entrega un producto de 180.00, y además hay un corte cancelado y un apartado sin recoger
- **THEN** el resumen de hoy da `servicesMinor` 30000, `cuts` 1, `productsMinor` 18000, `commissionMinor` 7500 y el día suma 48000

#### Scenario: Otra barbería
- **WHEN** el owner de otra barbería pide el resumen del mismo día
- **THEN** no ve nada de lo anterior
