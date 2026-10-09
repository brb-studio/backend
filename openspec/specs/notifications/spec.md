# notifications Specification

## Purpose
Avisos al barbero cuando le reservan, cancelan o mueven una cita: guardados, en vivo dentro del panel y como notificación push en el teléfono (PWA en Safari o Chrome). Código: `src/features/notifications/`, `src/db/notification-hub.ts` y `src/shared/web-push.ts`.

## Requirements

### Requirement: Aviso dentro de la misma transacción
Cada reserva, cancelación y reprogramación SHALL guardar, en la misma transacción, un aviso (`appointment.booked`, `appointment.cancelled` o `appointment.rescheduled`) para la cuenta vinculada al barbero, con hora local, cliente, servicios y sucursal. Nunca hay cita sin su aviso. Si el barbero no tiene cuenta vinculada, o si él mismo hizo el cambio, no se genera aviso. Los avisos se borran solos a los 90 días.

#### Scenario: El barbero agenda su propia cita
- **WHEN** un barbero crea una cita para sí mismo desde el panel
- **THEN** no recibe aviso de esa cita

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
Con las llaves VAPID configuradas (las tres o ninguna), el staff SHALL poder registrar el navegador de su teléfono para recibir push; sin llaves, la llave pública responde 404 `PUSH_DISABLED`. Solo se aceptan endpoints de servicios push conocidos: `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`, `*.push.apple.com` y `*.notify.windows.com`.

#### Scenario: Endpoint que no es un servicio push
- **WHEN** alguien registra como endpoint `https://evil.example/`
- **THEN** la suscripción se rechaza con 422 `VALIDATION`

### Requirement: Envío de notificaciones push
El push SHALL ir cifrado (RFC 8291, aes128gcm), firmado con VAPID ES256 y en el idioma de la barbería: título según el tipo, y cliente, servicios, hora y sucursal en el cuerpo. Se envía después de confirmar la transacción, con hasta 20 envíos simultáneos. Cuando el servicio push responde 404 o 410, la suscripción MUST borrarse.

#### Scenario: Teléfono que desinstaló la app
- **WHEN** el servicio push responde 410 a un envío
- **THEN** esa suscripción se borra
