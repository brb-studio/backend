# media Specification

## Purpose
Fotos de la barbería (cortes, paquetes, barberos y sucursales): subida segura, almacenamiento en MongoDB y galerías con portada. Código: `src/features/images/` y `src/shared/photos.ts`.

## Requirements

### Requirement: Subida segura de fotos
Owner, admin y manager SHALL poder subir fotos en bruto a `POST /v1/images`, de hasta 1 MB, y reciben un id aleatorio de 128 bits que no se puede adivinar. El sistema MUST cumplir todo esto:
- Determina el tipo por los primeros bytes del archivo y nunca por el `Content-Type` del cliente.
- Acepta solo JPEG, PNG y WebP. SVG queda fuera porque puede traer scripts.
- Admite como máximo 500 fotos por barbería y 60 subidas por usuario por hora.

#### Scenario: SVG disfrazado de PNG
- **WHEN** se sube un SVG con `Content-Type: image/png`
- **THEN** la respuesta es 415 `UNSUPPORTED_IMAGE`

#### Scenario: Foto demasiado grande
- **WHEN** el archivo pesa más de 1 MB
- **THEN** la respuesta es 413 `TOO_LARGE`

#### Scenario: Barbero o cliente intenta subir
- **WHEN** un barbero o un cliente sube una foto
- **THEN** la respuesta es 403 `FORBIDDEN`

### Requirement: Fotos públicas e inmutables
`GET /images/:id` SHALL servir la foto sin tenant ni sesión (las fotos aparecen en páginas públicas), con su tipo, caché de un año (`immutable`) y una política de contenido que no permite ejecutar nada. Un id con formato inválido o inexistente responde 404.

#### Scenario: Id inventado
- **WHEN** se pide `/images/aaaaaaaaaaaaaaaaaaaaaa`
- **THEN** la respuesta es 404

### Requirement: Galerías con portada
Servicios, paquetes, barberos y sucursales SHALL tener hasta 12 fotos (`images`), en orden; la primera es la portada (`image` en las vistas). Los documentos viejos que solo tienen `image` MUST leerse como una galería de una foto. Al guardar una galería se borra ese `image` viejo, para que una foto quitada no reaparezca.

#### Scenario: Más de 12 fotos
- **WHEN** se guardan 13 fotos en un servicio
- **THEN** la respuesta es 422 `VALIDATION`

#### Scenario: Vaciar la galería de un documento viejo
- **WHEN** un servicio que solo tenía `image` se guarda con `images: []`
- **THEN** la vista devuelve `images: []`, sin portada
