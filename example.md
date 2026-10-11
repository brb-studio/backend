[
  { _id: "tenant1", name: "MagicStudio", currency: "MXN" },
  { _id: "tenant2", name: "BarberShop", currency: "USD" }
]

const cursor = await t.tenants
        .find({ _id: { $in: ids((a) => a.tenant_id) } })
        .project<ViewTenant>({ name: 1, currency: 1 }),

const tenantOf = await mapBy(cursor, (doc) => doc._id);

La función key es (doc) => doc._id. Extrae el _id de cada documento y lo utiliza como clave.
