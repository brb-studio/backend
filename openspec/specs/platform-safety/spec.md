# platform-safety Specification

## Purpose
Reglas transversales que protegen a todas las barberías: aislamiento de datos, dinero sin decimales flotantes, errores sin datos internos, límites de intentos compartidos, IP real del visitante, límites de tamaño y configuración segura. Código: `src/db/`, `src/shared/`, `src/config.ts` y `src/app.ts`.

## Requirements

### Requirement: Aislamiento entre barberías
Todo documento de negocio SHALL llevar `tenantId`. Las features MUST acceder a los datos solo a través de `forTenant()` (`src/db/scoped.ts`), que agrega `tenantId` a cada consulta y escritura. Biome rechaza importar las colecciones crudas desde `src/features`. Pedir por id un recurso de otra barbería se comporta como si no existiera (404).

#### Scenario: Id de otra barbería
- **WHEN** el owner de la barbería A pide un barbero cuyo id pertenece a la barbería B
- **THEN** la respuesta es 404 `NOT_FOUND`

### Requirement: Dinero en unidades menores
Todo monto SHALL ser un entero en unidades menores de la moneda de la barbería (`3500` = 35.00). La base de datos MUST rechazar montos que no sean enteros.

#### Scenario: Monto flotante en la base
- **WHEN** algo intenta guardar `priceMinor: 35.5`
- **THEN** el validador de MongoDB lo rechaza

### Requirement: Errores sin información interna
Toda respuesta de error SHALL tener la forma `{ "error": { "code", "message", "issues"? } }` y un id de petición. El sistema MUST seguir estas reglas:
- Un error inesperado responde 500 `INTERNAL` genérico y el detalle solo se registra en el servidor.
- Una clave duplicada responde 409 `CONFLICT`.
- Una base de datos caída responde 503 `UNAVAILABLE`.
- Un id con formato inválido responde 404.

#### Scenario: Error inesperado
- **WHEN** un manejador lanza una excepción no prevista
- **THEN** el cliente recibe 500 `INTERNAL` sin stack trace ni mensaje interno

### Requirement: Límites de intentos compartidos
Los límites de intentos SHALL contarse en MongoDB (colección `rateLimits`) con ventanas fijas y un incremento atómico por intento, para que todas las instancias del servidor compartan la cuenta. Las llaves se guardan hasheadas (sin correos ni teléfonos) y un índice TTL borra las ventanas viejas.

#### Scenario: Intentos simultáneos
- **WHEN** llegan 30 intentos a la vez contra un límite de 20
- **THEN** pasan exactamente 20

### Requirement: IP real del visitante
El backend SHALL tomar como IP del visitante el `X-Forwarded-For` solo si la petición trae el secreto compartido `X-Proxy-Secret` igual a `PROXY_SECRET`, comparado en tiempo constante. De lo contrario usa la dirección del socket. `PROXY_SECRET` MUST existir en producción, porque sin él todos los visitantes compartirían un solo límite.

#### Scenario: IP falsificada
- **WHEN** un cliente envía `X-Forwarded-For: 1.2.3.4` sin el secreto
- **THEN** su límite se cuenta con la IP del socket

### Requirement: Límites de tamaño
Los cuerpos JSON MUST tener como máximo 64 KB (si no, 413 `TOO_LARGE`). Solo la subida de fotos acepta hasta 1 MB.

#### Scenario: JSON enorme
- **WHEN** se envía un cuerpo JSON de 70 KB a cualquier ruta
- **THEN** la respuesta es 413 `TOO_LARGE`

### Requirement: Configuración segura
La configuración SHALL validarse al arrancar sin mostrar valores, con estas reglas:
- Fuera de producción, MongoDB MUST ser `localhost`, `127.0.0.1` o `[::1]`.
- Bajo pruebas, la base MUST terminar en `_test`.
- Las llaves VAPID van completas o ausentes.
- `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET` van juntas.
- El precio de suscripción requiere la llave de Stripe.

Si la configuración es inválida, el proceso no arranca.

#### Scenario: Base remota en desarrollo
- **WHEN** en desarrollo `MONGO_URL` apunta a un host remoto
- **THEN** el servidor no arranca y el mensaje no incluye la URL ni sus credenciales
