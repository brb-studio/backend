# accounts-access Specification

## Purpose
Cuentas por barbería, inicio de sesión, sesiones, roles y gestión del equipo: quién es quién y qué puede tocar. Código: `src/features/auth/`.

## Requirements

### Requirement: Cuentas por barbería
Cada cuenta SHALL pertenecer a una sola barbería; el correo es único dentro de la barbería (índice `tenant_login_unique`, solo sobre cuentas con correo) y puede repetirse en otra, con la misma contraseña o con otra. `users` es la única colección de identidad: las cuentas de una misma persona en varias barberías son independientes y el sistema MUST NOT enlazarlas ni fusionarlas mientras el correo no esté verificado. Los clientes que reservan sin registrarse son registros `guest` (ver `booking`) que no pueden iniciar sesión. El registro público MUST crear solo clientes (`customer`). La contraseña MUST tener de 8 a 128 caracteres y guardarse solo como hash argon2id. El registro MUST llevar `acceptTerms: true` (el cliente acepta el aviso de privacidad y los términos y condiciones); sin eso responde 422 y no crea nada. La cuenta guarda la fecha en `termsAcceptedAt`, que se conserva aunque la cuenta se borre.

#### Scenario: Registro con correo ya usado
- **WHEN** alguien se registra con un correo que ya existe en esa barbería
- **THEN** la respuesta es 409 `EMAIL_TAKEN`

#### Scenario: Registro sin aceptar el aviso
- **WHEN** alguien se registra sin `acceptTerms: true`
- **THEN** la respuesta es 422 y no se crea la cuenta

#### Scenario: Mismo correo en otra barbería
- **WHEN** el correo existe en la barbería A y alguien se registra en la barbería B
- **THEN** se crea una cuenta nueva e independiente en B

#### Scenario: Contraseñas distintas por barbería
- **WHEN** la misma persona usa el mismo correo con contraseñas distintas en dos barberías
- **THEN** cada contraseña solo funciona en su barbería y la sesión de una MUST ser rechazada en la otra (401)

### Requirement: Inicio de sesión sin filtrar información
El sistema SHALL responder 401 `INVALID_CREDENTIALS` tanto si el correo no existe, como si la contraseña es incorrecta o la cuenta está inactiva, verificando siempre un hash para que el tiempo de respuesta no delate cuál fue. El sistema MUST limitar los intentos a 10 por cuenta (barbería y correo) cada 15 minutos; los siguientes responden 429 `RATE_LIMITED`.

#### Scenario: Fuerza bruta
- **WHEN** hay 11 intentos de inicio de sesión para el mismo correo en 15 minutos
- **THEN** el undécimo responde 429 `RATE_LIMITED` aunque la contraseña sea correcta

### Requirement: Sesiones opacas ligadas a su barbería
Iniciar sesión SHALL devolver un token aleatorio de 256 bits que se envía como `Authorization: Bearer`. Solo se guarda su SHA-256. La sesión dura 30 días, se renueva por otros 30 cuando le queda menos de la mitad y MongoDB borra las vencidas. Una sesión MUST valer solo en el host de su propia barbería y solo mientras la cuenta esté activa.

#### Scenario: Token usado en otra barbería
- **WHEN** un token de la barbería A se presenta en el host de la barbería B
- **THEN** la petición se trata como sin sesión

#### Scenario: Cerrar sesión
- **WHEN** el usuario cierra sesión
- **THEN** ese token deja de funcionar y sus otras sesiones siguen activas

### Requirement: Cambio de contraseña
Un usuario con sesión SHALL poder cambiar su contraseña enviando la actual. Si la actual no coincide, la respuesta MUST ser 403 `WRONG_PASSWORD`. Los intentos se limitan a 10 cada 15 minutos. Al cambiarla, la sesión actual sigue activa y todas las demás sesiones de esa cuenta se borran.

#### Scenario: Cambio exitoso
- **WHEN** el usuario cambia su contraseña desde su teléfono
- **THEN** sigue con sesión en ese teléfono y su sesión de la computadora deja de valer

### Requirement: Corregir los datos propios
Un cliente (`customer`) con sesión SHALL poder corregir su nombre y su teléfono (`PATCH /v1/auth/me` con `{ name, phone }`, ambos obligatorios; `phone: ""` lo quita), su derecho de rectificación (LFPDPPP). Se validan igual que en el registro (nombre de 2 a 80 caracteres, teléfono sin espacios, paréntesis ni guiones) y cualquier otro campo es 422. Si la cuenta tiene Customer de Stripe, primero se corrigen ahí nombre y teléfono; si Stripe falla, no cambia nada (502). El correo no se cambia aquí. Las citas y la lista de clientes muestran el dato nuevo porque leen la cuenta, no una copia. El personal MUST NOT usar esta ruta (403); sus datos los edita el dueño.

#### Scenario: Cliente corrige su nombre
- **WHEN** un cliente registrado como "Ana Lopes" envía `{ name: "Ana López", phone: "(664) 222-0000" }`
- **THEN** su cuenta queda con "Ana López" y `6642220000`, y así aparece en la lista de clientes de la barbería

#### Scenario: Cliente quita su teléfono
- **WHEN** un cliente envía `phone: ""`
- **THEN** su cuenta deja de tener teléfono

### Requirement: Borrar la cuenta propia
Un cliente (`customer`) con sesión SHALL poder borrar su cuenta (`POST /v1/auth/delete-account`) enviando su contraseña; si no coincide, 403 `WRONG_PASSWORD`, con 10 intentos cada 15 minutos. Mientras tenga una cita futura confirmada o esperando pago, o productos apartados, MUST responder 409 `OPEN_BOOKINGS` y no borrar nada. Al borrarla, el registro en `users` se queda con `deletedAt`, `active: false` y el nombre "Cliente eliminado" (en el idioma de la barbería), y pierde correo, teléfono, contraseña, correo de contacto, verificación y `stripeCustomerId`; antes se vacían nombre, correo y teléfono del Customer de Stripe y, si Stripe falla, no se borra nada (502). Se borran sus sesiones, enlaces de correo, suscripciones push, notificaciones y entradas en la lista de espera. Sus citas y apartados pasados se conservan apuntando al registro sin datos, para la contabilidad de la barbería. El personal MUST NOT borrar su propia cuenta (403); el dueño la desactiva.

#### Scenario: Cliente sin pendientes
- **WHEN** un cliente sin citas futuras borra su cuenta con la contraseña correcta
- **THEN** su sesión deja de valer, ya no puede iniciar sesión, su correo queda libre para registrarse de nuevo y sus citas pasadas siguen en los reportes

#### Scenario: Cliente con una cita próxima
- **WHEN** un cliente con una cita confirmada para mañana intenta borrar su cuenta
- **THEN** recibe 409 `OPEN_BOOKINGS` y su cuenta queda igual

### Requirement: Verificación de correo
Registrarse SHALL enviar al correo un enlace de un solo uso que vence en 24 horas; el registro MUST NOT abrir sesión (responde 201 con la cuenta y sin token). Un cliente (`customer`) con el correo sin verificar MUST NOT iniciar sesión: con la contraseña correcta recibe 403 `EMAIL_NOT_VERIFIED` y se le reenvía un enlace nuevo (dentro del límite de 3 por hora); con una incorrecta, el 401 de siempre. El personal creado por el dueño no necesita verificar para entrar. `POST /v1/auth/verify-email` con el token marca `emailVerifiedAt` y `GET /v1/auth/me` devuelve `emailVerified`. Un usuario con sesión puede pedir otro enlace (`POST /v1/auth/verify-email/request`, 3 por hora), y el nuevo MUST retirar el anterior. Solo se guarda el SHA-256 del token en `authTokens`, con TTL. Un enlace usado, vencido, inventado, de otra barbería o de otro propósito responde 400 `INVALID_TOKEN`. El sistema MUST NOT unir cuentas de distintas barberías por correo, ni siquiera verificado, sin una decisión de producto explícita.

#### Scenario: Cuenta sin confirmar
- **WHEN** alguien se registra con un correo inventado y luego intenta iniciar sesión
- **THEN** no recibe token (403 `EMAIL_NOT_VERIFIED`) hasta seguir el enlace enviado a ese correo

#### Scenario: Enlace reutilizado
- **WHEN** alguien usa por segunda vez el mismo enlace de verificación
- **THEN** la respuesta es 400 `INVALID_TOKEN`

### Requirement: Recuperación de contraseña
`POST /v1/auth/password/forgot` con un correo SHALL responder siempre 204, exista o no la cuenta, y solo enviar el correo (enlace de un solo uso, vigencia de 1 hora) si hay una cuenta activa con contraseña. Los envíos se limitan a 3 por hora por correo y 10 cada 15 minutos por visitante, con 429 `RATE_LIMITED`. `POST /v1/auth/password/reset` con el token y una contraseña de 8 a 128 caracteres SHALL cambiarla, marcar el correo como verificado y borrar todas las sesiones de la cuenta. El proveedor de correo es Resend (`RESEND_API_KEY` y `MAIL_FROM`, ambos o ninguno); si falla o no está configurado, el registro y la solicitud no fallan.

#### Scenario: Correo inexistente
- **WHEN** alguien pide recuperar la contraseña de un correo sin cuenta
- **THEN** la respuesta es 204 y no se envía ningún correo

#### Scenario: Restablecer con sesiones abiertas
- **WHEN** el usuario restablece su contraseña con el enlace
- **THEN** la contraseña vieja deja de servir y sus sesiones abiertas dejan de valer

### Requirement: Roles y alcance
El sistema SHALL manejar los roles `owner`, `admin`, `manager`, `barber` y `customer`. Owner y admin tienen alcance sobre toda la barbería; manager y barber solo sobre su sucursal (`branchId`); el barbero, además, solo sobre su propio perfil cuando la regla lo indica. Las rutas del staff MUST rechazar con 403 `FORBIDDEN` a los roles no permitidos y con 401 `UNAUTHENTICATED` a quien no tiene sesión.

#### Scenario: Cliente en una ruta del staff
- **WHEN** un cliente pide `GET /v1/appointments`
- **THEN** la respuesta es 403 `FORBIDDEN`

### Requirement: Gestión del equipo
Owner y admin SHALL poder listar, crear y editar cuentas del equipo. Crear una cuenta devuelve una sola vez una contraseña temporal aleatoria. Desactivar una cuenta MUST borrar todas sus sesiones.

#### Scenario: Desactivar a un empleado
- **WHEN** owner o admin pone `active: false` a un barbero
- **THEN** sus sesiones dejan de valer de inmediato

### Requirement: Sin escalar privilegios
El sistema MUST cumplir estas reglas al gestionar el equipo:
- Solo el owner otorga el rol `admin`.
- Nadie edita al owner.
- Un admin no edita a otros admins, aunque sí puede cambiar su propio nombre.
- Nadie cambia su propio rol, su sucursal ni su estado `active`.

Cualquier intento fuera de estas reglas responde 403 `FORBIDDEN`.

#### Scenario: Admin intenta crear otro admin
- **WHEN** un admin crea una cuenta con rol `admin`
- **THEN** la respuesta es 403 `FORBIDDEN`

#### Scenario: Cambiarse el rol a sí mismo
- **WHEN** un admin intenta cambiar su propio rol
- **THEN** la respuesta es 403 `FORBIDDEN`

### Requirement: Sucursal según el rol
Manager y barber MUST tener `branchId`; un admin MUST NOT tenerlo (si no se cumple, 422 `VALIDATION`). Mover de rol o de sucursal una cuenta vinculada a un perfil de barbero responde 409 `LINKED_BARBER` hasta desvincularla.

#### Scenario: Mover a un barbero vinculado
- **WHEN** se cambia de sucursal la cuenta de un barbero que tiene perfil vinculado
- **THEN** la respuesta es 409 `LINKED_BARBER`

### Requirement: Exportar los datos propios
Un cliente SHALL poder descargar `GET /v1/auth/me/export` con lo que la barbería guarda de él: perfil, citas (con su pago y su cobro en mostrador), avisos, lista de espera y apartados de productos. Solo entran registros de esa barbería. La exportación MUST NOT incluir contraseña, sesiones, claves de dispositivos para avisos ni identificadores de Stripe. El staff recibe 403.

#### Scenario: Descarga de los propios datos
- **WHEN** un cliente pide su exportación
- **THEN** recibe su perfil y sus registros de esa barbería, sin los de otra

#### Scenario: Staff intenta descargar
- **WHEN** un owner, admin, encargado o barbero pide `GET /v1/auth/me/export`
- **THEN** la respuesta es 403 `FORBIDDEN`

### Requirement: Contraseña temporal del equipo
Las cuentas de staff que crea el owner o un admin SHALL empezar con una contraseña temporal y con `mustChangePassword`. Mientras esa marca esté activa, solo `POST /v1/auth/password`, `GET /v1/auth/me` y `POST /v1/auth/logout` responden; cualquier otra ruta MUST responder 403 `PASSWORD_CHANGE_REQUIRED`. Cambiar la contraseña, o restablecerla con el enlace del correo, quita la marca.

#### Scenario: Primer inicio de sesión con contraseña temporal
- **WHEN** el staff entra con la contraseña temporal
- **THEN** la respuesta incluye `user.mustChangePassword: true` y el panel le pide elegir una contraseña antes de mostrar cualquier sección

#### Scenario: Ruta del panel con la marca activa
- **WHEN** el staff con la marca pide `GET /v1/appointments/my-day`
- **THEN** la respuesta es 403 `PASSWORD_CHANGE_REQUIRED`

#### Scenario: Cambio de contraseña quita la marca
- **WHEN** el staff cambia su contraseña
- **THEN** la marca se quita y las rutas del panel responden normalmente
