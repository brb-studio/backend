# barbers-schedule Specification

## Purpose
Perfiles de barbero, su horario, los servicios que hacen, la cuenta vinculada y las ausencias o cierres que bloquean la agenda. Código: `src/features/barbers/`.

## Requirements

### Requirement: Perfil de barbero
Cada barbero SHALL pertenecer a una sucursal y tener slug único en la barbería (409 `SLUG_TAKEN` si se repite), nombre, especialidad y biografía en es/en, hasta 12 fotos y horario semanal. Si no se envía horario, MUST tomar el de su sucursal. Varios intervalos en un día representan turnos partidos; los huecos son descansos. Owner, admin y manager (este solo en su sucursal) crean y editan perfiles.

#### Scenario: Barbero sin horario propio
- **WHEN** se crea un barbero sin `hours`
- **THEN** su horario es el de su sucursal

### Requirement: Límite de barberos del plan
El número de barberos activos MUST NOT superar el límite del plan; crear o reactivar uno más responde 402 `PLAN_LIMIT`.

#### Scenario: Plan basic con 5 barberos activos
- **WHEN** se crea un sexto barbero activo
- **THEN** la respuesta es 402 `PLAN_LIMIT`

### Requirement: Servicios que hace cada barbero
Los `serviceIds` de un barbero SHALL ser servicios válidos para todas las sucursales o para la sucursal del barbero. Esta lista decide qué puede reservarse con él (ver `catalog`).

#### Scenario: Servicio de otra sucursal
- **WHEN** se asigna a un barbero de Centro un servicio exclusivo de Norte
- **THEN** la respuesta es 422 `VALIDATION`

### Requirement: Cuenta vinculada
Un perfil SHALL poder vincularse con una cuenta de rol `barber` de la misma sucursal; con cualquier otra cuenta la respuesta MUST ser 422 `VALIDATION`. Una cuenta tiene como máximo un perfil (409 `USER_LINKED` si ya tiene uno), y enviar `userId: null` desvincula. La cuenta vinculada recibe los avisos de sus citas.

#### Scenario: Vincular una cuenta ya vinculada
- **WHEN** se vincula una cuenta que ya tiene perfil de barbero
- **THEN** la respuesta es 409 `USER_LINKED`

### Requirement: Ausencias y cierres
El staff SHALL poder bloquear la agenda de un barbero (`break`, `time_off`, `vacation`, `block`) o cerrar toda una sucursal (`closure`). Las fechas se capturan en hora local de la sucursal (`YYYY-MM-DDTHH:MM`) y el fin MUST ser posterior al inicio.

#### Scenario: Cierre de sucursal
- **WHEN** un manager cierra su sucursal un día sin citas
- **THEN** ningún barbero de esa sucursal tiene horarios libres ese día

### Requirement: Ausencias que chocan con citas
Una ausencia o un cierre MUST NOT encimarse con citas confirmadas. La validación se hace con el barbero bloqueado (o todos los de la sucursal, en un cierre), así que ninguna reserva se cuela mientras se valida. Si hay choque, la respuesta es 409 `APPOINTMENTS_IN_THE_WAY` con hasta 20 de esas citas y su hora local.

#### Scenario: Vacaciones encima de citas
- **WHEN** se registran vacaciones que se enciman con dos citas confirmadas del barbero
- **THEN** la respuesta es 409 `APPOINTMENTS_IN_THE_WAY` con esas dos citas, y no se guarda nada

### Requirement: Quién maneja cada ausencia
Un barbero SHALL crear y borrar solo sus propias ausencias; sobre las de otros, o al cerrar la sucursal, recibe 403 `FORBIDDEN`. La lista muestra solo entradas que no han terminado: el barbero ve las suyas y los cierres de su sucursal.

#### Scenario: Barbero borra la ausencia de otro
- **WHEN** un barbero intenta borrar las vacaciones de un compañero
- **THEN** la respuesta es 403 `FORBIDDEN`
