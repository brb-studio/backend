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

### Requirement: Historial de pagos de la barbería
El owner y el admin SHALL ver los pagos a barberos de su barbería hechos en un rango de días locales (`GET /v1/earnings/payouts?from=&to=`, máximo 366 días; el día de cada pago es el de la zona de la sucursal del barbero), en `rows`, del más nuevo al más viejo: barbero, sucursal, importe, moneda, cuántos cortes liquida, referencia si la tiene y cuándo se pagó. La barbería sale siempre de la sesión; un manager recibe 403.

#### Scenario: Pago recién registrado
- **WHEN** el dueño paga un corte de Mateo con 25 % sobre 300.00 y consulta el historial de ese día
- **THEN** ve un pago de Mateo por 75.00 que liquida 1 corte

### Requirement: Trazabilidad por corte
El detalle de un corte SHALL mostrar cliente, servicios, descuento, precio cobrado, pago, comisión (porcentaje, base, importe y si viene de la cita o de la configuración actual) y el pago al barbero con su fecha y referencia.

#### Scenario: Corte con comisión ya pagada
- **WHEN** el staff abre un corte completado cuya comisión se liquidó
- **THEN** ve el porcentaje congelado en la cita, el importe y el pago al barbero con su fecha y referencia

### Requirement: Ganancias de la propia barbería
La pantalla web de Ganancias SHALL leer el libro de movimientos (`GET /v1/money/summary` y `GET /v1/money/movements`, ver "Resumen y movimientos de dinero"): periodo por día, semana, mes o rango, entradas, salidas y neto contra el periodo anterior, gráfica de entradas y salidas, servicios contra productos, desglose por método, movimientos filtrables y exportación a CSV. Mientras la app móvil migra, `GET /v1/earnings/summary` se conserva con su cálculo anterior: El owner y el admin SHALL ver lo que entró a su barbería en un rango de días locales (máximo 366): cortes completados (`servicesMinor` y su número `cuts`), productos entregados (`productsMinor`, por el día de su cobro en la zona de su sucursal) y la comisión de los barberos sobre esos cortes (`commissionMinor`, con las mismas reglas que "Comisión sin porcentajes inventados"), cómo entró (`collected`: lo cobrado en línea, en mostrador en efectivo, tarjeta o transferencia, con los productos en efectivo o SPEI, y `unrecordedMinor` para cortes completados sin cobro registrado), más el total bruto de cada día del rango (días sin ventas en 0). La barbería sale siempre de la sesión y solo se suman importes en su moneda. Cortes cancelados, citas por pagar y apartados sin entregar MUST NOT sumar.

#### Scenario: Día con un corte y un producto
- **WHEN** hoy se completa un corte de 300.00 de un barbero al 25 % y se entrega un producto de 180.00, y además hay un corte cancelado y un apartado sin recoger
- **THEN** el resumen de hoy da `servicesMinor` 30000, `cuts` 1, `productsMinor` 18000, `commissionMinor` 7500 y el día suma 48000

#### Scenario: Otra barbería
- **WHEN** el owner de otra barbería pide el resumen del mismo día
- **THEN** no ve nada de lo anterior

### Requirement: Corte de caja
Owner, admin y manager SHALL ver la caja de un día local (`GET /v1/cash?date=&branchId=`) leída del libro de movimientos: todos los registros cuyo `localDate` es ese día, en orden de hora, con entradas (`inMinor`), salidas (`outMinor`), balance del día (`netMinor`), el desglose por método (`byMethod`) y cada movimiento (`entries`) con su dirección, tipo, concepto, método, canal, cliente, quién lo registró, referencia, la cita o el pedido de origen y la hora en la zona de su sucursal. Cuentan también los pagos con Stripe y sus comisiones, reembolsos, contracargos y pagos a barberos. `pending` dice cuántos cortes completados ese día tienen saldo sin cobro registrado y cuánto suman: es informativo y MUST NOT sumarse al dinero. Mientras la app móvil migra, la respuesta conserva `totals`, `people`, `movements` y `unrecorded` (solo entradas cobradas por staff, por método y por persona). La suma de la caja de cada día de un rango MUST ser igual al resumen de ese rango en `GET /v1/money/summary`. El manager solo ve su sucursal (otra, 404); owner y admin todas o una. Barberos y clientes reciben 403.

#### Scenario: Cierre del día
- **WHEN** hoy se cobraron 300.00 en efectivo, 200.00 con tarjeta y se entregó un producto de 180.00 por SPEI
- **THEN** la caja de hoy da efectivo 30000, tarjeta 20000 y transferencia 18000, con lo de cada persona, y entradas por 68000

#### Scenario: Transferencia aceptada antes de la cita
- **WHEN** hoy el admin acepta una transferencia SPEI de 250.00 con clave de rastreo para una cita de mañana
- **THEN** la caja de hoy suma 25000 en transferencia a nombre del admin, con el cliente, la hora en que se aceptó, la clave de rastreo y la fecha de la cita
- **AND** la caja de mañana no la vuelve a contar

#### Scenario: Pago a barbero
- **WHEN** hoy se cobran 300.00 en efectivo y se le pagan 150.00 de comisión a un barbero
- **THEN** la caja de hoy da entradas 30000, salidas 15000 y balance 15000

### Requirement: Libro de movimientos
Cada entrada o salida de dinero de una barbería SHALL anotarse en `ledgerEntries` en la misma transacción que la produce, con su instante (`at`), su día local en la zona de la sucursal fijado al guardar (`localDate`), dirección (`in`/`out`), tipo, método, canal, monto positivo en unidades menores, moneda, concepto copiado al momento y quién lo registró (sin `recordedBy` = Stripe). Se anotan: cobro en mostrador al completar (`service_payment`), transferencia SPEI aceptada (`service_payment`, canal `spei`), pago con Stripe confirmado (`service_payment`, canal `online`) y la comisión que retiene la plataforma (`online_fee`), cada reembolso de Stripe con su monto (`refund`), cada contracargo (`chargeback`), producto entregado (`product_sale`) y pago de comisión a un barbero (`payout`). El valor de una cita nunca entra al libro, solo el dinero recibido o devuelto; cancelar no anota nada por sí solo. Los registros MUST NOT editarse ni borrarse; cada uno tiene una llave única por origen y evento (`source`), así que la migración `scripts/migrate-ledger.ts` puede correr varias veces sin duplicar. Los reembolsos y contracargos antiguos migrados llevan `approximate: true` porque su fecha y monto por evento no se guardaban.

#### Scenario: Corte con anticipo en línea
- **WHEN** un cliente paga 75.00 de anticipo con tarjeta hoy y mañana paga los 225.00 restantes en efectivo al completar
- **THEN** el libro tiene un `service_payment` de 7500 hoy (más su `online_fee`) y otro de 22500 mañana en efectivo

#### Scenario: Cliente cancela a tiempo una cita pagada
- **WHEN** el cliente cancela a tiempo una cita de 300.00 pagada con tarjeta
- **THEN** el libro tiene la entrada de 30000, la comisión de 1601 y el reembolso de 28399, y el neto de esa cita es 0

### Requirement: Resumen y movimientos de dinero
Owner, admin y manager SHALL leer el libro en un rango de días locales (máximo 366): `GET /v1/money/summary?from=&to=&groupBy=day|week|month&branchId=` da entradas, salidas y neto; el desglose por tipo y por método; servicios contra productos; la serie por día, semana (inicia en lunes) o mes; y el mismo total del periodo anterior de igual duración. `GET /v1/money/movements?from=&to=&direction=&type=&method=&branchId=&page=&pageSize=` lista cada movimiento, del más reciente al más antiguo, con cliente, quién lo registró y referencia, paginado (página ≤100). Solo cuentan importes en la moneda de la barbería. El manager solo ve su sucursal (otra, 404); barberos y clientes reciben 403. La suma de los resúmenes de cada día de un rango MUST ser igual al resumen del rango.

#### Scenario: Caja contra Ganancias
- **WHEN** se pide el resumen de cada uno de tres días y el del rango de esos tres días
- **THEN** la suma de entradas, salidas y neto de los tres días es igual a la del rango

### Requirement: Gastos, ajustes y reversiones
Owner y admin SHALL registrar con `POST /v1/money/entries` un gasto (`expense`: siempre salida, con monto, método, sucursal y concepto; nota opcional), un ajuste (`adjustment`: entrada o salida con nota obligatoria) o la reversión de un movimiento (`{ type: "adjustment", reverses, note }`): un ajuste por el mismo monto, método, concepto y sucursal en la dirección contraria, con la nota obligatoria. Un movimiento MUST revertirse a lo más una vez (409 `ALREADY_REVERSED`, garantizado por un índice único) y una reversión no se revierte (409 `NOT_REVERSIBLE`). El día del registro es el día local de su sucursal al guardarlo. El manager, barberos y clientes no pueden registrar (403). La caja marca los movimientos ya revertidos (`reversed`) y los que revierten a otro (`reverses`).

#### Scenario: Gasto capturado dos veces
- **WHEN** el owner registra un gasto de 450.00 en tarjeta por error y luego lo revierte con la nota "Se capturó dos veces"
- **THEN** la caja del día suma salida 45000, entrada 45000 y balance 0, y una segunda reversión responde 409
