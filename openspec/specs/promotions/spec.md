# promotions Specification

## Purpose
Descuentos de cada barbería: cuándo aplican, cuánto descuentan, cuál gana y cómo se cuentan los usos sin pasarse del límite. Código: `src/features/promotions/` (reglas puras en `rules.ts`).

## Requirements

### Requirement: Tipos de descuento
Una promoción SHALL ser `percent` (de 1 a 100) o `fixed` (en unidades menores de la moneda). El porcentaje MUST redondear hacia abajo y el monto fijo nunca superar el subtotal, así que el total nunca es negativo.

#### Scenario: Monto fijo mayor que el precio
- **WHEN** una promoción fija de 500 se aplica a un servicio de 300
- **THEN** el descuento es 300 y el total es 0

### Requirement: Con código o automática
Una promoción con código (único en la barbería; si se repite, 409 `CODE_TAKEN`) SHALL aplicar solo cuando el cliente escribe ese código. Una promoción sin código MUST aplicar sola a toda reserva elegible.

#### Scenario: Primera visita automática
- **WHEN** existe "15% primera visita" sin código y reserva un cliente sin visitas previas
- **THEN** el descuento se aplica sin que escriba nada

### Requirement: Vigencia y alcance
Una promoción SHALL aplicar solo si está activa y el momento actual cae entre `startsAt` (incluido) y `endsAt` (excluido). Además, la sucursal debe estar en su lista o la lista debe estar vacía, y el servicio o paquete debe estar en sus listas o ambas listas deben estar vacías.

#### Scenario: Código para otra sucursal
- **WHEN** se usa en Norte un código limitado a Centro
- **THEN** no se aplica y el motivo es `branch`

### Requirement: Condiciones del cliente y del subtotal
Una promoción MUST aplicar solo si cumple todas estas condiciones:
- El subtotal alcanza `minSubtotalMinor`.
- Con `firstVisitOnly`, el cliente no tiene citas confirmadas ni completadas.
- El cliente no llegó a `maxPerCustomer` usos (cuentan las citas no canceladas).
- No se agotaron los canjes (`maxRedemptions`).

#### Scenario: Cliente que ya vino
- **WHEN** un cliente con una cita completada usa una promoción de primera visita
- **THEN** no se aplica y el motivo es `first_visit`

### Requirement: Motivo cuando un código no aplica
Cuando un código escrito no aplica, el sistema SHALL informar el motivo: `inactive`, `not_started`, `expired`, `branch`, `item`, `min_subtotal`, `first_visit`, `customer_limit`, `exhausted` o `unknown_code`.

#### Scenario: Código inexistente
- **WHEN** el cliente cotiza con un código que no existe
- **THEN** la cotización trae el precio completo y el motivo `unknown_code`

### Requirement: Gana el mayor descuento
Entre las promociones que aplican, el sistema SHALL usar la que da el mayor descuento. Nunca acumula dos.

#### Scenario: Dos automáticas elegibles
- **WHEN** aplican una de 10% y una fija equivalente a 15%
- **THEN** se usa la fija

### Requirement: Canje atómico y devolución
El uso de una promoción SHALL contarse dentro de la transacción de la reserva, con un incremento condicionado a que siga activa y no haya llegado a `maxRedemptions`. Si se agotó en ese instante, la reserva MUST responder 409 `PROMOTION_UNAVAILABLE`. Cancelar una cita devuelve su uso, sin bajar de cero.

#### Scenario: Último cupo
- **WHEN** queda un canje y dos reservas lo usan a la vez
- **THEN** una lo obtiene y la otra recibe 409 `PROMOTION_UNAVAILABLE`

### Requirement: Administración
Owner y admin SHALL crear y editar promociones. El sistema MUST validar que un porcentaje esté entre 1 y 100, que `startsAt` sea anterior a `endsAt` y que las sucursales, servicios y paquetes referidos existan en la barbería.

#### Scenario: Fechas invertidas
- **WHEN** `endsAt` es anterior a `startsAt`
- **THEN** la respuesta es 422 `VALIDATION`
