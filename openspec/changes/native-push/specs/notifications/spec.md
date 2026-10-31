## ADDED Requirements

### Requirement: Registro de dispositivos nativos
Cualquier cuenta con sesión (cliente o staff) SHALL poder registrar el token de Expo Push de su app móvil con `POST /v1/notifications/native-devices` `{ token, platform }`, donde `token` tiene el formato `ExponentPushToken[...]` o `ExpoPushToken[...]` y `platform` es `ios` o `android`. Registrar un token ya existente lo actualiza: pasa a la cuenta que lo registra. Cada cuenta conserva como máximo 10 dispositivos; al registrar uno nuevo se borran los más antiguos por último uso. Un token mal formado responde 422 sin guardar nada.

#### Scenario: El cliente registra su teléfono
- **WHEN** un cliente con sesión envía un token de Expo válido de iOS
- **THEN** el token queda guardado para su cuenta y la respuesta es 204

#### Scenario: Token inválido
- **WHEN** el token no tiene el formato de Expo Push
- **THEN** la respuesta es 422 y no se guarda nada

#### Scenario: Undécimo dispositivo
- **WHEN** una cuenta ya tiene 10 dispositivos y registra otro
- **THEN** se borra el dispositivo con el último uso más antiguo y el nuevo queda guardado

### Requirement: Baja de dispositivos nativos
La app SHALL poder borrar su token con `DELETE /v1/notifications/native-devices` `{ token }`, solo si pertenece a la cuenta con sesión. Al borrar la cuenta, se borran todos sus tokens nativos.

#### Scenario: Cierre de sesión
- **WHEN** la app borra su token al cerrar sesión
- **THEN** ese dispositivo deja de recibir avisos de esa cuenta

### Requirement: Envío a dispositivos nativos
Cada aviso que hoy sale por Web Push SHALL enviarse también a los dispositivos nativos de la cuenta destinataria, por el Expo Push Service, en lotes de hasta 100 mensajes. El mensaje nativo MUST NOT incluir el nombre del cliente, los servicios ni la sucursal: solo el título (tipo de aviso y barbería), la fecha y hora, y la ruta a abrir. Un fallo del servicio de push no deshace la reserva ni el pago. La ausencia de claves VAPID no impide el envío nativo.

#### Scenario: Reserva nueva con barbero con teléfono
- **WHEN** un cliente reserva una cita con un barbero que tiene la app instalada
- **THEN** el barbero recibe el aviso en su teléfono con el título y la hora, sin el nombre del cliente

### Requirement: Limpieza de tokens inválidos
Cuando el Expo Push Service responde que un dispositivo ya no está registrado (`DeviceNotRegistered`), el backend SHALL borrar ese token de inmediato, ya sea en la respuesta de envío o en un recibo posterior. Los demás errores solo se registran en el log y no borran el token.

#### Scenario: App desinstalada
- **WHEN** el servicio de push responde `DeviceNotRegistered` para un token
- **THEN** el token se borra y no vuelve a recibir avisos
