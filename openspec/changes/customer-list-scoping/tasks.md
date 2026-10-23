## 1. Backend
- [x] 1.1 `listCustomers()` limita al manager a clientes con citas en su sucursal (cursor de `customerId`).
- [x] 1.2 `hit("customers:<userId>", 60, 10 min)` → 429 `RATE_LIMITED`.
- [x] 1.3 Pruebas: manager de A no ve a un cliente que solo reservó en B; el dueño ve a ambos; límite responde 429.

## 2. Specs
- [x] 2.1 `booking` actualizado con los escenarios de manager y límite.
- [x] 2.2 typecheck, biome, `bun run test`, `bun run test:int`, `openspec validate --specs --strict`.
