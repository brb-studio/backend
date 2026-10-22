## 1. Backend
- [x] 1.1 `deletedAt` en `UserDoc` y rama del validador para clientes borrados.
- [x] 1.2 `deleteAccount()`: contraseña, límite de intentos, 409 con pendientes, Stripe, anonimizar y limpiar sesiones, push, notificaciones y lista de espera.
- [x] 1.3 `POST /v1/auth/delete-account` solo para clientes.
- [x] 1.4 Pruebas de integración en `tests/customers.test.ts`.

## 2. Frontend
- [x] 2.1 Página de aviso de privacidad y enlace desde Cuenta.
- [x] 2.2 Aviso simplificado bajo el formulario de registro.
- [x] 2.3 "Borrar mi cuenta" en Cuenta (solo clientes).

## 3. Specs
- [x] 3.1 `accounts-access` actualizado; README.
- [x] 3.2 typecheck, biome, `bun run test`, `bun run test:int`.
- [ ] 3.3 Revisión del texto del aviso por un abogado.

## 4. Aceptación en el registro
- [x] 4.1 `acceptTerms: true` obligatorio en `POST /v1/auth/register`; `users.termsAcceptedAt`.
- [x] 4.2 Frontend: drawer inferior con el aviso y los términos al abrir el registro; sin aceptar no se envía.
- [ ] 4.3 Página completa de términos y condiciones (cancelaciones y reembolsos) revisada por un abogado.
