## MODIFIED Requirements

### Requirement: Reprogramación por el staff
El staff SHALL poder mover una cita confirmada a otro horario y/o a otro barbero, hasta 365 días adelante. El cambio MUST revalidarse con el motor sin contar la propia cita como ocupada. Un barbero no puede pasar su cita a otro barbero (403 `FORBIDDEN`). Los horarios que se le ofrecen (`GET /v1/appointments/:id/slots`, con `from`, `days` y `barberId` opcionales) usan la duración y los servicios guardados en la cita, incluyen solo barberos activos de su sucursal que hacen esos servicios y no cuentan la propia cita como ocupada. El alcance es el de la agenda: el manager solo ve citas de su sucursal y el barbero solo las suyas, y a él mismo como único barbero. Una cita que no está confirmada responde 409 `NOT_CONFIRMED`.

#### Scenario: Barbero pasa su cita a un compañero
- **WHEN** un barbero cambia el `barberId` de su cita
- **THEN** la respuesta es 403 `FORBIDDEN`

#### Scenario: Su propia hora sale libre
- **WHEN** el dueño pide los horarios para mover una cita de las 10:00
- **THEN** las 10:00 de ese barbero aparecen libres, y los barberos que no hacen esos servicios no aparecen
