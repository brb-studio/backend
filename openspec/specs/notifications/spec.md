# notifications Specification

## Purpose
Avisos al barbero cuando le reservan, cancelan o mueven una cita, y al cliente con cuenta cuando la barbería cambia su cita o su pago: guardados, en vivo dentro del panel y como notificación push en el teléfono (PWA en Safari o Chrome). Código: `src/features/notifications/`, `src/db/notification-hub.ts` y `src/shared/web-push.ts`.

## Requirements

### Requirement: Aviso dentro de la misma transacción
Cada reserva, cancelación y reprogramación SHALL guardar, en la misma transacción, un aviso (`appointment.booked`, `appointment.cancelled` o `appointment.rescheduled`) para la cuenta vinculada al barbero, con hora local, cliente, servicios y sucursal. Nunca hay cita confirmada sin su aviso. Si el barbero no tiene cuenta vinculada, o si él mismo hizo el cambio, no se genera aviso. Los avisos se borran solos a los 90 días.

#### Scenario: El barbero agenda su propia cita
- **WHEN** un barbero crea una cita para sí mismo desde el panel
- **THEN** no recibe aviso de esa cita

### Requirement: Aviso también por correo
Cada aviso guardado (barbero, cliente, owners y admins) SHALL enviarse además por correo, tras confirmar la transacción, al correo de la cuenta destinataria activa, con el mismo título y cuerpo del push y el enlace a la barbería. Un fallo del proveedor de correo MUST NOT deshacer la reserva ni el pago. Los recordatorios mantienen su propio correo (no se duplica). No hay interruptor por usuario todavía.

### Requirement: Avisos al cliente
El cliente con cuenta SHALL recibir un aviso (`customer.booked`, `customer.cancelled`, `customer.rescheduled`, `customer.paid`, `customer.payment_rejected` o `customer.reminder`) cuando alguien más cambia su cita o su pago: el staff agenda, cancela o reprograma, el staff confirma o rechaza su transferencia, o el proveedor confirma su pago en línea. Se guarda en la misma transacción. MUST NOT generarse aviso por lo que el propio cliente hace (cancelar, o reservar en línea sin pago pendiente) ni para invitados, que no tienen sesión.

#### Scenario: Staff reprograma la cita de un cliente con cuenta
- **WHEN** el staff cambia la hora de la cita de un cliente con cuenta
- **THEN** el cliente recibe `customer.rescheduled` y su teléfono, si lo registró, el push

#### Scenario: Invitado
- **WHEN** el staff cancela la cita de un invitado
- **THEN** no se genera ningún aviso

### Requirement: Transferencia por confirmar
Cuando un cliente pide los datos de una transferencia SPEI manual (y se crea el pago pendiente), el sistema SHALL guardar `payment.transfer_requested` para cada owner y admin activo, en la misma transacción, para que confirmen el depósito. Pedir los datos otra vez mientras el pago sigue pendiente MUST NOT generar otro aviso.

#### Scenario: Cliente pide transferencia
- **WHEN** un cliente pide los datos de transferencia de su cita
- **THEN** owners y admins reciben el aviso y el push

### Requirement: Resumen diario para dueños y admins
Cada mañana, entre las 08:00 y las 12:00 de la hora local de cada sucursal activa, el sistema SHALL enviar por push a cada owner y admin activo un resumen de esa sucursal: citas confirmadas de hoy y transferencias SPEI pendientes de confirmar. Se envía una sola vez por sucursal y día, y MUST NOT enviarse si ambas cifras son 0 ni a barberías con suscripción vencida. El resumen no se guarda en la bandeja. Lo dispara el mismo temporizador de tareas programadas que los recordatorios (ver abajo). Un owner que también es barbero sigue recibiendo además el aviso individual de sus propias citas.

#### Scenario: Día sin nada que informar
- **WHEN** una sucursal no tiene citas hoy ni transferencias pendientes
- **THEN** no se envía resumen

#### Scenario: Segundo disparo el mismo día
- **WHEN** el resumen de una sucursal ya salió hoy y el temporizador vuelve a correr
- **THEN** no se envía otro

### Requirement: Tareas programadas
Un temporizador del servidor (cada 10 minutos) o `GET /cron/tick` (alias `GET /cron/digest`) con `Authorization: Bearer $CRON_SECRET` SHALL ejecutar, para cada barbería con suscripción activa, el resumen diario, los recordatorios de cita, los avisos de la lista de espera (capability `waitlist`) y el vencimiento de los apartados de productos (capability `products`). Sin `CRON_SECRET` esas rutas responden 404. Un fallo en una tarea o barbería MUST NOT detener a las demás.

#### Scenario: Ruta sin secreto
- **WHEN** se llama a `/cron/tick` sin el secreto correcto
- **THEN** la respuesta es 404

### Requirement: Recordatorios de cita
El sistema SHALL recordar al cliente cada cita confirmada **24 horas** y **2 horas** antes, por push (si tiene cuenta y teléfono registrado) y por correo (al `email` de su cuenta o al `contactEmail` del invitado). Las cuentas lo reciben además como aviso `customer.reminder`; los invitados no tienen bandeja. Cada recordatorio de cada cita, para la hora a la que está agendada, MUST enviarse una sola vez aunque el temporizador corra varias veces o desde varias instancias. Si varios están vencidos a la vez (el temporizador estuvo caído), solo se envía el más cercano. MUST NOT recordarse una cita cancelada, sin pago confirmado, ya empezada ni un recordatorio cuyo momento es anterior a la reserva. Reprogramar una cita arma recordatorios nuevos para la nueva hora. Una barbería con `reminders.enabled: false` no envía recordatorios. El correo menciona dónde cancelar o reprogramar; un invitado sin correo no recibe nada.

#### Scenario: Cita en 23 horas
- **WHEN** corre el temporizador y una cita confirmada empieza en 23 horas
- **THEN** el cliente recibe un recordatorio y las siguientes corridas no lo repiten

#### Scenario: Temporizador caído
- **WHEN** el temporizador vuelve cuando faltan 90 minutos para una cita que no recibió ningún recordatorio
- **THEN** recibe solo el de 2 horas

#### Scenario: Reserva de último momento
- **WHEN** un cliente reserva una cita para dentro de 5 horas
- **THEN** no recibe el recordatorio de 24 horas, solo el de 2 horas

### Requirement: Avisos de pagos en línea
Una reserva pagada en línea SHALL guardar `appointment.booked` en la transacción que confirma el pago, no al apartar el horario. Una disputa de pago MUST guardar `payment.disputed` para cada owner y admin activo.

#### Scenario: Reserva aún sin pagar
- **WHEN** un cliente aparta un horario y todavía no paga
- **THEN** el barbero no recibe aviso hasta que el pago se confirma

### Requirement: Bandeja de avisos
Cada usuario del staff SHALL ver sus últimos 50 avisos y el número de no leídos, y poder marcar como leídos algunos (hasta 100 ids) o todos. Un usuario MUST NOT ver avisos de otro.

#### Scenario: Marcar todo como leído
- **WHEN** el barbero marca todos como leídos
- **THEN** su contador de no leídos queda en 0

### Requirement: Avisos en vivo
`GET /v1/notifications/stream` SHALL mantener una conexión Server-Sent Events con los eventos `ready`, `notification` y `ping`, este último cada 15 segundos. Cada proceso abre un solo change stream de MongoDB y lo reparte a todas sus conexiones, para que el aviso llegue aunque la reserva se haya hecho en otra instancia del servidor.

#### Scenario: Reserva en otra instancia
- **WHEN** la reserva se procesa en la instancia A y el barbero está conectado a la instancia B
- **THEN** el barbero recibe el evento `notification` en su panel

### Requirement: Registro de teléfonos para push
Con las llaves VAPID configuradas (las tres o ninguna), cualquier cuenta con sesión (staff o cliente) SHALL poder registrar el navegador de su teléfono para recibir push; sin llaves, la llave pública responde 404 `PUSH_DISABLED`. Solo se aceptan endpoints de servicios push conocidos: `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`, `*.push.apple.com` y `*.notify.windows.com`.

#### Scenario: Endpoint que no es un servicio push
- **WHEN** alguien registra como endpoint `https://evil.example/`
- **THEN** la suscripción se rechaza con 422 `VALIDATION`

### Requirement: Envío de notificaciones push
El push SHALL ir cifrado (RFC 8291, aes128gcm), firmado con VAPID ES256 y en el idioma de la barbería: título según el tipo seguido del nombre de la barbería (`Nueva cita · Barbería X`, para distinguir cuentas en varias barberías), y en el cuerpo cliente (staff) o barbero (cliente), servicios, hora y sucursal. Se envía después de confirmar la transacción, con hasta 20 envíos simultáneos. Cuando el servicio push responde 404 o 410, la suscripción MUST borrarse.

#### Scenario: Teléfono que desinstaló la app
- **WHEN** el servicio push responde 410 a un envío
- **THEN** esa suscripción se borra
