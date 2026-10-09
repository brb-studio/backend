# accounts-access Specification

## Purpose
Cuentas por barbería, inicio de sesión, sesiones, roles y gestión del equipo: quién es quién y qué puede tocar. Código: `src/features/auth/`.

## Requirements

### Requirement: Cuentas por barbería
Cada cuenta SHALL pertenecer a una sola barbería; el correo es único dentro de la barbería y puede repetirse en otra. El registro público MUST crear solo clientes (`customer`). La contraseña MUST tener de 8 a 128 caracteres y guardarse solo como hash argon2id.

#### Scenario: Registro con correo ya usado
- **WHEN** alguien se registra con un correo que ya existe en esa barbería
- **THEN** la respuesta es 409 `EMAIL_TAKEN`

#### Scenario: Mismo correo en otra barbería
- **WHEN** el correo existe en la barbería A y alguien se registra en la barbería B
- **THEN** se crea una cuenta nueva e independiente en B

### Requirement: Inicio de sesión sin filtrar información
El sistema SHALL responder 401 `INVALID_CREDENTIALS` tanto si el correo no existe, como si la contraseña es incorrecta o la cuenta está inactiva, verificando siempre un hash para que el tiempo de respuesta no delate cuál fue. El sistema MUST limitar los intentos a 10 por cuenta (barbería y correo) cada 15 minutos; los siguientes responden 429 `RATE_LIMITED`.

#### Scenario: Fuerza bruta
- **WHEN** hay 11 intentos de inicio de sesión para el mismo correo en 15 minutos
- **THEN** el undécimo responde 429 `RATE_LIMITED` aunque la contraseña sea correcta

### Requirement: Sesiones opacas ligadas a su barbería
Iniciar sesión o registrarse SHALL devolver un token aleatorio de 256 bits que se envía como `Authorization: Bearer`. Solo se guarda su SHA-256. La sesión dura 30 días, se renueva por otros 30 cuando le queda menos de la mitad y MongoDB borra las vencidas. Una sesión MUST valer solo en el host de su propia barbería y solo mientras la cuenta esté activa.

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
