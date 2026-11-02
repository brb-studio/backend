## Why
Las fotos se guardan como binarios en MongoDB, con 1 MB por foto y sin redimensionar. Para cortes, paquetes, productos, barberos y el logo de cada barbería se quiere un CDN que entregue cada foto al tamaño que pide la pantalla.

## What Changes
- `POST /v1/images` guarda la foto en Get Pronto cuando existe `GETPRONTO_API_KEY` y devuelve `url` (CDN, https). Sin la llave sigue igual (MongoDB).
- Las validaciones no cambian (tipo por bytes, 1 MB, 500 por barbería, 60 por hora). El registro en `images` guarda `url` y `providerId` en lugar de `data`.
- Si Get Pronto falla: 502 `IMAGE_STORE_FAILED`, sin registro.
- `?kind=` en la subida (logo, brand, services, packages, products, barbers, branches, other), guardado en `images.kind`.
- Nuevo `brand.logo` en `PATCH /v1/tenant`.

## Decisions
- **El backend hace de intermediario.** La llave secreta nunca sale del servidor, y los límites y permisos siguen en un solo lugar.
- **Sin SDK.** Son tres llamadas con `fetch`, como Resend y Stripe.
- **Plan Free.** Los clientes piden solo `w`, `h` y `fit`; `format=auto` puede ser del plan Pro.
- **Una carpeta por barbería con su `_id`.** El slug podría repetirse o cambiar; el `_id` no. El tipo va en el nombre (`products-<id>.jpg`) porque las docs de Get Pronto no dicen si las carpetas se pueden anidar.
- **Fotos viejas.** Las que ya están en MongoDB se siguen sirviendo en `/images/:id`; no se migran.

## Impact
- Specs: `media` y `tenancy` (deltas en `specs/`).
- Código: `src/features/images/getpronto.ts` (nuevo), `service.ts`, `routes.ts`, `src/config.ts`, `src/db/collections.ts`, `src/features/tenancy/schemas.ts`.
- Clientes: web y app guardan la `url` que regresa la subida, piden las fotos al tamaño de cada vista y muestran el logo.
