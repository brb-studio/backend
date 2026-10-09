# catalog Specification

## Purpose
Servicios y paquetes que vende cada barbería, sus precios y duraciones, y la regla única de quién puede hacer qué. Código: `src/features/catalog/` (reglas puras en `rules.ts`).

## Requirements

### Requirement: Servicios
Un servicio SHALL tener slug único, nombre en es o en (máximo 80 caracteres), descripción opcional (máximo 500), duración de 5 a 720 minutos, precio entero en unidades menores de 0 a 10,000,000, posición, hasta 12 fotos y, opcionalmente, una sucursal. Sin sucursal, sirve en todas; la sucursal no cambia después de crearlo. Owner y admin crean y editan servicios. Un servicio no se borra: se desactiva con `active: false`.

#### Scenario: Precio con decimales
- **WHEN** se envía `priceMinor: 35.5`
- **THEN** la respuesta es 422 `VALIDATION`

### Requirement: Paquetes con precio propio
Un paquete SHALL tener precio propio y de 2 a 10 servicios activos, en orden y con repetición permitida, que encajen con la sucursal del paquete. Su duración y su precio por separado MUST calcularse siempre a partir de los servicios actuales y nunca guardarse. La vista del staff indica si todos sus servicios siguen activos (`servicesActive`).

#### Scenario: Paquete con un servicio inactivo
- **WHEN** se crea un paquete que incluye un servicio desactivado
- **THEN** la respuesta es 422 `VALIDATION`

#### Scenario: Cambia el precio de un servicio
- **WHEN** sube el precio de un servicio incluido
- **THEN** el precio por separado del paquete refleja el nuevo valor y el precio propio del paquete no cambia

### Requirement: Regla única de quién puede hacer qué
Un barbero SHALL poder atender una solicitud si y solo si cumple las cuatro condiciones:
- está activo;
- cada servicio solicitado está activo;
- cada servicio encaja con la sucursal del barbero y está en sus `serviceIds`;
- si es un paquete, el paquete encaja con su sucursal.

El catálogo público, el filtro de barberos, la disponibilidad y la reserva MUST usar esta misma regla.

#### Scenario: Paquete con un servicio que el barbero no hace
- **WHEN** se pide el paquete "corte y barba" con un barbero que solo hace corte
- **THEN** ese barbero no aparece como opción y una reserva directa responde 409 `BARBER_UNAVAILABLE`

### Requirement: Catálogo público
`GET /v1/public/catalog` SHALL devolver la moneda y los servicios y paquetes que al menos un barbero activo de una sucursal activa puede hacer, ordenados por posición y luego por slug. Con `?branch=` se limita a esa sucursal.

#### Scenario: Servicio sin barbero
- **WHEN** ningún barbero activo hace un servicio
- **THEN** ese servicio no aparece en el catálogo público
