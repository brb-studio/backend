import type {
  ClientSession,
  Collection,
  CountDocumentsOptions,
  Filter,
  FindOneAndUpdateOptions,
  FindOptions,
  ObjectId,
  OptionalUnlessRequiredId,
  UpdateFilter,
} from "mongodb";
import { client } from "./client";
import * as raw from "./collections";

export type * from "./collections";
export {
  APPOINTMENT_STATUSES,
  LOCALES,
  PLANS,
  REFERRAL_STATUSES,
  ROLES,
  STATUSES,
  TIME_OFF_KINDS,
} from "./collections";

type InSession = { session?: ClientSession };

function scope<T extends { tenantId: ObjectId }>(
  collection: Collection<T>,
  tenantId: ObjectId,
) {
  const where = (filter: Filter<T> = {}) =>
    ({ ...filter, tenantId }) as Filter<T>;
  return {
    find: (filter?: Filter<T>, options?: FindOptions) =>
      collection.find(where(filter), options),
    findOne: (filter?: Filter<T>, options: FindOptions = {}) =>
      collection.findOne(where(filter), options),
    countDocuments: (filter?: Filter<T>, options?: CountDocumentsOptions) =>
      collection.countDocuments(where(filter), options),
    insertOne: (doc: Omit<T, "tenantId">, options?: InSession) =>
      collection.insertOne(
        { ...doc, tenantId } as OptionalUnlessRequiredId<T>,
        options,
      ),
    updateOne: (
      filter: Filter<T>,
      update: UpdateFilter<T>,
      options?: InSession,
    ) => collection.updateOne(where(filter), update, options),
    findOneAndUpdate: (
      filter: Filter<T>,
      update: UpdateFilter<T>,
      options: FindOneAndUpdateOptions & { includeResultMetadata?: false } = {},
    ) => collection.findOneAndUpdate(where(filter), update, options),
    updateMany: (
      filter: Filter<T>,
      update: UpdateFilter<T>,
      options?: InSession,
    ) => collection.updateMany(where(filter), update, options),
    deleteOne: (filter: Filter<T>, options?: InSession) =>
      collection.deleteOne(where(filter), options),
  };
}

export const forTenant = (tenantId: ObjectId) => ({
  branches: scope(raw.branches, tenantId),
  users: scope(raw.users, tenantId),
  barbers: scope(raw.barbers, tenantId),
  timeOff: scope(raw.timeOff, tenantId),
  services: scope(raw.services, tenantId),
  packages: scope(raw.packages, tenantId),
  customers: scope(raw.customers, tenantId),
  appointments: scope(raw.appointments, tenantId),
  promotions: scope(raw.promotions, tenantId),
  notifications: scope(raw.notifications, tenantId),
  pushSubscriptions: scope(raw.pushSubscriptions, tenantId),
  images: scope(raw.images, tenantId),
});

export type TenantDb = ReturnType<typeof forTenant>;

export const platform = {
  tenants: raw.tenants,
  referrals: raw.referrals,
  sessions: raw.sessions,
  pushSubscriptions: raw.pushSubscriptions,
  images: raw.images,
  appointments: raw.appointments,
};

export async function runAll<T>(
  tasks: (() => Promise<T>)[],
  session?: ClientSession,
): Promise<T[]> {
  if (!session) return Promise.all(tasks.map((task) => task()));
  const results: T[] = [];
  for (const task of tasks) results.push(await task());
  return results;
}

export const transaction = <T>(work: (session: ClientSession) => Promise<T>) =>
  client.withSession((session) =>
    session.withTransaction(() => work(session), {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    }),
  );
