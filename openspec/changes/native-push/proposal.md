## Why
La app móvil nativa (Expo) no puede recibir avisos: hoy las notificaciones salen solo por Web Push con VAPID, que requiere claves de navegador y un endpoint de navegador. Sin un canal nativo, el barbero y el cliente no se enteran de reservas, cancelaciones ni cambios en el teléfono.

## What Changes
- Registro y baja de tokens de Expo Push por cuenta y dispositivo: `POST` y `DELETE /v1/notifications/native-devices`, con sesión (cliente o staff).
- Los mismos avisos que hoy van por Web Push se envían también a los dispositivos nativos, por el Expo Push Service, con contenido mínimo.
- Limpieza de tokens inválidos: al enviar (ticket `DeviceNotRegistered`) y con recibos periódicos en la tarea programada.
- Al cerrar sesión la app borra su token; al borrar la cuenta se borran todos sus tokens.
- Nuevas colecciones `nativePushDevices` y `pushReceipts`. Variables opcionales `EXPO_ACCESS_TOKEN` y `EXPO_PUSH_API_URL`.
- Nueva capability: no. Se amplía `notifications`.

## Decisions
- **Expo Push Service, no APNs/FCM directo.** Las credenciales de APNs y FCM viven en EAS, no en el backend. Costo: el proveedor ve el token y el contenido del aviso, por eso el contenido es mínimo (ver siguiente).
- **Contenido mínimo para nativo.** Título con el tipo de aviso y la barbería; cuerpo solo con la fecha y hora. No viajan nombre del cliente, servicios ni sucursal. La app abre la pantalla y carga el detalle autenticada. Web Push no cambia.
- **Un token pertenece a una cuenta.** Si el mismo token llega desde otra cuenta, pasa a esa cuenta (igual que `endpoint` en Web Push).
- **Máximo 10 dispositivos por cuenta.** Al registrar uno nuevo, se borran los más antiguos por `lastSeenAt`.
- **Sin SDK.** Llamadas con `fetch` y timeout, como el resto del backend (política de dependencias).
- **Canal independiente de VAPID.** Un servidor sin claves VAPID sigue enviando a nativo.

## Impact
- Specs: `notifications` (requisitos nuevos, delta en `specs/notifications/spec.md`).
- Código: `src/features/notifications/native-push.ts` (nuevo), `routes.ts`, `service.ts` (`deliverMessages`), `digest.ts` (`runScheduled`, recibos), `src/features/auth/erase.ts`, `src/db/collections.ts`, `src/db/scoped.ts`, `src/config.ts`.
- Cliente: la app Expo registra y da de baja su token (`mobile/`).
