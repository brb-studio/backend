# 03 — Prácticas backend obligatorias (para IA)

> Patrones exigidos y prohibiciones duras. El ejemplo canónico es `src/features/platform/queries.ts`.

## 1. Lecturas: cursores planos + `for await` secuencial (NUNCA `aggregate`/`$lookup`)

**Prohibido:** `collection.aggregate(...)`, `$lookup`, `$group` en servidor, y `Promise.all` sobre cursores que lean la misma colección grande.

**Exigido:** un `find()` con filtro por índice + `.project()` mínimo + `for await` secuencial + suma/agrupación en JS. Medido en 400k citas: año de una barbería 680 ms → 87 ms; año de todas 13 s → 1.6 s.

Patrón canónico (de `platform/queries.ts:164-181`):

```ts
// 1. Tasa pequeña primero, a memoria (rateMap). 2. Cursor plano con proyección mínima. 3. Suma en JS.
const rates = await rateMap(f); // un read pequeño → Map en memoria
const cursor = platform.appointments.find(scope(f)).project<Row>(REPORT_FIELDS);
for await (const a of cursor) {
  if (!inPeriod(f, a)) continue; // filtro fino local-día por sucursal
  add(totals, a, rates);         // suma en JS, memoria constante por grupo
}
```

Reglas de cursor:

- `.project()` solo los campos usados (`REPORT_FIELDS` en `queries.ts:77-90`). Nunca documentos completos.
- Filtro grueso UTC en el índice (`scope()`: rango `startAt` ±1 día) + filtro fino en JS (día local por `timeZone` de la sucursal).
- `for await` **secuencial**. No paralelizar el consumo del cursor.
- Joins en memoria: `rateMap()` (tasas), `byId()`/`mapBy()` (entidades), `names()` (3 reads batcheados con `$in`, nunca uno por fila). Ver `queries.ts:334-367`.
- Paginación de reportes: pasa 1 = solo `_id`+`startAt` (tiny) → ordena en JS → pasa 2 = solo la página (`_id: { $in }`). Ver `listAppointments` (`queries.ts:386-451`).
- Contadores pequeños y acotados (`children` por tenant/branch) también van con `for await` + `.project()` de 1–2 campos (`queries.ts:273-298`).

### 1.1 `collect` / `mapBy` — cuándo y cómo (`src/shared/cursor.ts:8-39`)

Firmas reales (sobrecargadas, infieren el tipo de retorno — no las redeclares):

```ts
collect<T>(cursor: AsyncIterable<T>): Promise<T[]>;
collect<T, R>(cursor: AsyncIterable<T>, pick: (doc: T) => R): Promise<R[]>;
mapBy<T, K>(cursor: AsyncIterable<T>, key: (doc: T) => K): Promise<Map<K, T>>;
mapBy<T, K, R>(cursor: AsyncIterable<T>, key: (doc: T) => K, pick: (doc: T) => R): Promise<Map<K, R>>;
```

| Forma | Úsala cuando… | Ejemplo real |
|---|---|---|
| `collect(cursor)` | Necesitas todos los docs y el set está **acotado** (`limit`) | `collect(t.timeOff.find(...).sort(...).limit(500))` (`barbers/time-off.ts:122-124`) |
| `collect(cursor, pick)` | Solo necesitas algunos campos o una forma distinta | `collect(cursor, (d) => ({ id: hex(d._id), name: d.name }))` (`platform/queries.ts:527-528`) |
| `mapBy(cursor, key)` | Vas a buscar por clave (en vez de `.find()` sobre un array) | `mapBy(cursor, idOf)` con `idOf = (doc: { _id: ObjectId }) => hex(doc._id)` (`platform/queries.ts:191,249-257`) |
| `mapBy(cursor, key, pick)` | Map con valores slim/transformados | `mapBy(docs, d => d.id, d => ({ n: d.n }))` (patrón verificado en `shared/cursor.test.ts:21-28`) |
| `for await` directo | Agregación/suma en streaming **sin materializar** | `totalsBy` (`queries.ts:164-181`), contadores `barbersOf`/`branchesOf` (`queries.ts:273-298`) |

Memoria: `for await` evita crear un array intermedio de documentos completos, pero **el resultado final sigue ocupando memoria** (el array de `collect` o el `Map` de `mapBy`). Por eso: acota siempre con `.limit()` + `.project()` mínimo + `pick` slim cuando el set puede crecer.

Cierre del cursor: consumir el cursor hasta agotar el `for await` lo libera. Si sales **antes** (`break`/`return` anticipado), cierra explícitamente con `await cursor.close()`. No asumas cierre automático en salida anticipada.

Antipatrones:

- `.toArray()` sobre result sets completos de documentos (solo en listas acotadas: entidades ≤2000, página ≤100).
- Construir un `Map` con un loop manual cuando `mapBy` sirve.
- `collect` sin `pick` cuando solo usas 2–3 campos del documento.
- `Promise.all` consumiendo el mismo cursor en paralelo.

### 1.2 Tipado de proyecciones MongoDB

Fuente de verdad: los tipos `*Doc` de `src/db/collections.ts` (`TenantDoc`, `BranchDoc`, `BarberDoc`, `AppointmentDoc`, `PayoutDoc`, …), re-exportados por `src/db/scoped.ts`. Si existe schema inferido aplicable úsalo; en este proyecto las proyecciones derivan de los `*Doc` persistidos, no de los schemas Zod (esos son contratos HTTP, no tipos de DB).

- `.project<Pick<Doc, "...">>({...})` y el `Pick` debe listar **exactamente** los campos proyectados. MongoDB devuelve `_id` salvo exclusión explícita → incluye `"_id"` en el `Pick` cuando no lo excluyes. Ejemplo verificado (`queries.ts:249-257`):

```ts
const [tenantOf, branchOf] = await Promise.all([
  mapBy(
    platform.tenants
      .find({ _id: { $in: tenantIds } })
      .project<Pick<TenantDoc, "_id" | "name" | "currency">>({
        name: 1,
        currency: 1,
      }),
    idOf,
  ),
  // ...
]);
```

- `Required<Pick<...>>` cuando el campo es opcional en el `Doc` pero el filtro garantiza su existencia (`rateMap`: `.project<Required<Pick<BarberDoc, "_id" | "commissionBps">>>>`, `queries.ts:102-104`; `commissionBps?` es opcional en `BarberDoc` en `collections.ts:138`).
- Tipos locales de proyección **solo** cuando se mezcla o deriva (no repitas campos a mano): `Row` (`Pick` de `AppointmentDoc`, `queries.ts:61-75`), `Entity` (`Pick` + `Partial`, `queries.ts:193-194`), `Barber` (`Pick` de `BarberDoc`, `queries.ts:331`). Prohibido crear interfaces que copien campo por campo lo que un `Pick` ya expresa.
- Distingue persistido vs. inserción/actualización: `scope().insertOne` acepta `Omit<T, "tenantId">` (`scoped.ts:41-45`) — no reutilices el `Doc` completo para construir inserciones.
- Respeta opcionales, `ObjectId` y `Date` originales: no conviertas `_id` a `string` en el tipo de proyección (convierte al presentar, con `hex()`), no marques un opcional como requerido salvo `Required<Pick>` justificado por el filtro.
- Verificación: `bun run typecheck` — acceder a un campo no incluido en el `Pick` falla en compilación. Si cambias la proyección, cambia el `Pick` en el mismo edit.

### 1.3 Criterios de rendimiento

- Proyecta solo los campos necesarios (ver 1.2) y filtra **antes** de procesar: filtro grueso indexable en el `find` + filtro fino en JS (patrón `scope()` + `inPeriod()`).
- Evita arrays intermedios y duplicación: prefiere `for await` acumulando o `collect` con `pick` slim; no hagas `collect` completo para luego mapear a otra forma en un segundo array.
- Usa los índices adecuados a las consultas reales (índices de `appointments` en `collections.ts`/`setup.ts`: `barber_start_confirmed_unique`, `tenant_branch_start`, `barber_start`, `tenant_customer_start`, `payment_intent`, `start`). No crees índices redundantes ni optimices sin evidencia: mide con datos reales antes de añadir un índice.
- Dimensiona el resultado: cada `Map`/array final vive en memoria → `.limit()`, reads batcheados con `$in` (nunca uno por fila), paginación en 2 pases (`listAppointments`, `queries.ts:386-451`).
- Mantén trazabilidad y tenancy en **todas** las consultas: `forTenant()` en features, filtros `tenantId`/`branchId`/`barberId` en `platform` (ver sección 2).

## 2. Tenancy (seguridad multi-tenant)

- Todo documento de negocio lleva `tenantId`. Acceso **solo** vía `forTenant(tenantId)` (`src/db/scoped.ts:66`). Biome falla el build si `src/features/**` importa `db/client` o `db/collections`.
- `platform.*` (`scoped.ts:83`) = lecturas cross-tenant. **Solo `src/features/platform/`.** Si tu feature no es platform, no lo toques.
- Transacciones: `transaction(work)` (`snapshot` + `majority`). Dentro de una sesión, `runAll()` ejecuta **secuencial** (MongoDB prohibe operaciones paralelas en una sesión).

## 3. Separación HTTP / servicio / reglas puras

- `routes.ts` = solo HTTP: parse Zod, auth, códigos de estado, llama a `service.ts`. Sin queries inline ni aritmética de negocio.
- `service.ts` = reglas + queries (scoped, cursores, transacciones).
- `rules.ts` / `engine.ts` / `commission.ts` = funciones puras, sin DB, con `*.test.ts` al lado. Se verifican con `bun run test` (sin DB).
- TypeScript estricto: `noUncheckedIndexedAccess`, sin `any`. Indexar un `Map`/array exige manejar `undefined`.

### 3.1 Tipado estricto (sin evasiones)

- No uses `any` para evadir comprobaciones (cero `any` en `src/`). `unknown` solo para **estrechar**, no para evadir: variables `catch (err: unknown)` y type guards como `isDuplicate(err: unknown)` (`shared/http.ts:118-121`) que luego se refinan con `instanceof`/predicados. Nunca dejes un `unknown` sin estrechar antes de usarlo.
- No uses conversiones inseguras (`as unknown as R` y similares). Las sobrecargas de `collect`/`mapBy` ya conservan el tipo exacto de retorno: se infiere `R` desde `pick` (`cursor.test.ts:18-28` — `const numbers: number[] = await collect(docs(), (d) => d.n)` compila sin anotar el retorno de `pick`). Si necesitas un cast, el código está mal tipado: arregla el tipo en vez del cast.
- En `pick`, deja que TypeScript infiera el objeto seleccionado; no declares manualmente tipos que la inferencia ya deduce, y no anotes el `Map`/array resultante con un tipo distinto al inferido salvo para fijar el contrato del llamador.
- No uses un tipo completo de documento cuando la consulta devuelve una proyección parcial: si proyectas 3 campos, el tipo es `Pick<Doc, ...>`, nunca el `Doc` entero (acceder al resto debe fallar en compilación, no en producción).
- Tipado estático ≠ validación en tiempo de ejecución: los tipos no validan el contenido de la DB. La validación vive en los validadores BSON (`collections.ts`) y en Zod en los bordes HTTP (bodies estrictos, 422). No confíes un invariante de runtime solo a un tipo.

## 4. Dinero, tiempo, contratos

- **Dinero:** enteros en unidades menores (`priceMinor`, `totalMinor`, `amountMinor`), validador `bsonType: "int"`. Cero floats, cero Decimal128. Comisión: `totalMinor × commissionBps / 10000`, half-up, solo en `platform/commission.ts`. Monedas nunca se suman (un total por `currency`).
- **Tiempo:** instantes = UTC `Date`. Horarios comerciales = `"HH:MM"` local en la zona IANA de la sucursal, conversiones con Temporal (`shared/time.ts`). El engine de disponibilidad convierte zona 1 vez por ventana, no por slot.
- **Contratos:** errores siempre `{ error: { code, message, issues? } }`, `code` en MAYÚSCULAS y estable (`AppError` en `shared/http.ts`). Schemas Zod **estrictos**: keys desconocidas = 422. Rangos acotados (`days` 1–31 público / 365 staff, agenda ≤62 días, platform ≤366 días, página ≤100).

## 5. Auth, rate-limit, seguridad

- Passwords argon2id (`Bun.password`). Sesiones: token aleatorio 256-bit, solo se guarda su SHA-256, TTL de MongoDB las borra. Sesiones tenant (30d, renuevan pasada la mitad) ≠ sesiones platform (12h, colecciones separadas).
- Rate limits: ventana fija en colección `rateLimits`, un upsert atómico por intento (todas las instancias comparten el conteo). Claves hasheadas SHA-256 (nunca emails/teléfonos en claro).
- IP del visitante: solo vale `X-Visitor-IP` (o `X-Forwarded-For`, que Vercel sobrescribe) si viene con `X-Proxy-Secret` (`PROXY_SECRET`, exigido en prod); si no, se usa la IP del socket (en Vercel, `X-Vercel-Forwarded-For`). El frontend elige la IP según `TRUSTED_PROXY_HOPS`.
- Uploads: tipo leído de los bytes (SVG rechazado), ≤1 MB, cuotas 500/tenant y 60/h por usuario. Push: solo hosts conocidos (anti-SSRF), envío post-commit en chunks de 20.

## 6. Booking concurrente (transacción)

Orden obligatorio dentro de la transacción: subir `lockVersion` del barbero (WriteConflict → retry) → re-chequear disponibilidad con el mismo engine → `$inc` condicional de la promo → insertar cita + notificación del barbero (sin notificación no hay reserva). Backstop: índice único parcial `{ barberId, startAt }`.

## 7. Dependencias y verificación

- Política: pins exactos, versiones con ≥3 días de antigüedad (`bunfig.toml`), `trustedDependencies: []`, `bun.lock` comprometido. Antes de añadir un paquete: ¿lo hacen Bun/TS/lo instalado? Si no, exige transitivas, advisories, mantenimiento y scripts.
- DB safety: fuera de prod, solo hosts `localhost`/`127.0.0.1`/`::1`. Bajo `bun test`, solo DBs `*_test`. Solo se toca `MONGO_DB`.
- Antes de dar por terminado, corre: `bun run typecheck`, `bun run lint`, `bun run test` (+ `bun run test:int` si tocaste queries, + `openspec validate --specs --strict` si tocaste specs).
- Cómo verificar esta sección: `typecheck` valida los `Pick` de cada `.project()` (un campo de más o de menos rompe la compilación donde se usa); `bun run test` cubre la inferencia de `collect`/`mapBy` (`shared/cursor.test.ts`); `test:int` cubre las queries reales contra MongoDB. Rendimiento: mide con datos reales (rango + `explain` si dudas del índice) antes de añadir índices o cambiar el patrón.

## 8. Archivos ≤500 líneas y clean code incremental

Ningún archivo `.ts` supera las **500 líneas** (incluye `.test.ts`: si el test crece, el exceso va en otro archivo de test por tema, no mezclado). Un archivo largo esconde responsabilidades mezcladas y frena la lectura; uno corto se revisa de una sentada.

- **Código nuevo:** cumple desde el primer PR. Si tu cambio empuja un archivo sobre 500, divídelo **en el mismo cambio**: extrae funciones puras a `rules.ts`/`engine.ts`/`commission.ts` con su `.test.ts`, separa queries por subdominio, mueve contratos a `schemas.ts`.
- **Código existente que hoy excede:** no hay refactors big-bang. Regla boy-scout: cada vez que toques uno de estos archivos para un feature o fix, extrae **al menos una pieza coherente** y deja el archivo más pequeño que como lo encontraste. Deuda conocida (medido hoy):
  - `src/db/collections.ts` — 1186 (registro de tipos+validadores+índices; dirección: dividir por dominio, p. ej. `db/<dominio>.ts`, cuando se toque).
  - `src/features/booking/service.ts` — 964 (dirección: ya existen `order.ts`/`customers.ts`; sigue extrayendo por subdominio: cancel, reschedule, walk-in).
  - `src/features/platform/queries.ts` — 543 (dirección: `summary`/`breakdown`/`listAppointments`/`options` a módulos propios).
  - `src/features/billing/service.ts` — ~430 (dirección: separar pagos/referidos).
- **Cómo dividir:** por responsabilidad (HTTP → servicio → reglas puras, ver sección 3) y por subdominio (un archivo = un tema: `barbers/service.ts` + `barbers/time-off.ts` es el ejemplo a seguir). Nombres por lo que contienen, no `utils.ts`/`helpers.ts` genéricos dentro de features.
- **Verificación:** antes de dar por terminado, corre `find src tests -name '*.ts' -exec wc -l {} + | sort -rn | head` y confirma que ningún archivo que tocaste supera 500 líneas.
