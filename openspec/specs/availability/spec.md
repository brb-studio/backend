# availability Specification

## Purpose
Cálculo de horarios libres: un motor puro que comparten la consulta pública, la del staff, la reserva y la reprogramación. Código: `src/features/availability/engine.ts` y `service.ts`.

## Requirements

### Requirement: Ventanas de trabajo
Para cada día, el sistema SHALL tomar la intersección entre el horario de la sucursal y el del barbero para ese día de la semana. Los huecos entre intervalos son descansos y nunca se ofrecen.

#### Scenario: Barbero entra más tarde que la sucursal
- **WHEN** la sucursal abre de 10:00 a 20:00 y el barbero trabaja de 12:00 a 20:00
- **THEN** no se ofrecen horarios antes de las 12:00

### Requirement: Horarios a intervalo fijo
Los inicios posibles SHALL generarse cada `slotIntervalMin` desde la apertura de cada ventana. Un horario solo se ofrece si inicio más duración no pasa del cierre. La duración es la suma de los servicios solicitados (o la guardada en la cita, al reprogramar).

#### Scenario: Servicio de 45 minutos al cierre
- **WHEN** la ventana cierra a las 20:00, el intervalo es de 15 minutos y la duración es de 45
- **THEN** el último horario ofrecido es a las 19:15

### Requirement: Bloqueos, citas y margen
Un horario MUST NOT encimarse con ausencias ni cierres. Tampoco su fin más el margen (`bufferMin`) MUST encimarse con citas confirmadas, cada una ocupada hasta su fin más el margen (`blockedUntil`).

#### Scenario: Margen entre citas
- **WHEN** hay una cita de 10:00 a 10:45 con margen de 15 minutos
- **THEN** el siguiente inicio libre es a las 11:00

### Requirement: Anticipación y ventana de reserva
En línea, el sistema SHALL ofrecer solo horarios a partir de ahora más `minNoticeMin` y solo dentro de los próximos `windowDays` días, contados desde hoy en la zona de la sucursal. El staff MUST tener la misma regla sin anticipación mínima y con hasta 365 días. Una consulta abarca como máximo 31 días.

#### Scenario: Cliente que quiere reservar en 30 minutos
- **WHEN** `minNoticeMin` es 60 y faltan 30 minutos para un horario libre
- **THEN** ese horario no se ofrece en línea, pero el staff sí lo ve

### Requirement: Zona horaria y cambios de horario
Los horarios SHALL calcularse en la zona IANA de la sucursal. Las horas locales que no existen o se repiten por el cambio de horario MUST NOT ofrecerse.

#### Scenario: Día de cambio de horario
- **WHEN** las 02:30 locales no existen ese día
- **THEN** ese inicio no se ofrece

### Requirement: Misma regla al reservar
Toda reserva y reprogramación SHALL validar el horario con este mismo motor dentro de su transacción. Lo que se ofreció y lo que se acepta MUST coincidir siempre.

#### Scenario: Horario que ya no está libre
- **WHEN** alguien envía un inicio que el motor ya no considera libre
- **THEN** la reserva responde 409 `SLOT_TAKEN`

### Requirement: Consultas pública y del staff
La consulta pública SHALL usar slugs y devolver solo barberos que pueden atender la solicitud. La del staff usa ids, y un barbero solo se ve a sí mismo. Ambas devuelven las fechas reservables, la duración y los horarios por barbero y por día, con su hora local.

#### Scenario: Barbero consulta la agenda del staff
- **WHEN** un barbero pide disponibilidad del staff de su sucursal
- **THEN** solo recibe sus propios horarios
