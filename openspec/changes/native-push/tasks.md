## 1. Datos y configuración
- [x] 1.1 Colecciones `nativePushDevices` (token único, tenant y usuario, validador) y `pushReceipts` (TTL 2 días) en `src/db/collections.ts`
- [x] 1.2 Acceso en `src/db/scoped.ts` (tenant-scoped para lectura, plataforma para upsert global)
- [x] 1.3 Variables opcionales `EXPO_ACCESS_TOKEN` y `EXPO_PUSH_API_URL` en `src/config.ts`

## 2. Registro y baja
- [x] 2.1 `POST /v1/notifications/native-devices` y `DELETE /v1/notifications/native-devices` (validación estricta del token de Expo)
- [x] 2.2 Límite de 10 dispositivos por cuenta (borra los más antiguos)
- [x] 2.3 Borrado de tokens en `src/features/auth/erase.ts`

## 3. Envío
- [x] 3.1 Mensaje nativo mínimo (título y hora, sin datos personales) en `service.ts` (`nativeMessage`) y reglas en `native-rules.ts`
- [x] 3.2 `deliverMessages` envía también a nativo aunque no haya VAPID, en lotes de 100
- [x] 3.3 Tickets `DeviceNotRegistered` borran el token al instante; los demás errores solo se registran

## 4. Recibos
- [x] 4.1 Guardar ticket `ok` en `pushReceipts`
- [x] 4.2 Tarea programada consulta recibos y borra tokens `DeviceNotRegistered`

## 5. Pruebas
- [x] 5.1 Unitarias: validación del token, construcción del mensaje, lectura de tickets y recibos (`native-rules.test.ts`)
- [x] 5.2 Integración: registro, baja, límite, envío a un servidor de Expo simulado, limpieza por recibo (`tests/native-push.test.ts`, 6 pruebas)
- [x] 5.3 `bun run lint`, `bun run typecheck`, `bun run test` y `bun run test:int` (239 de 239 en la suite completa)
