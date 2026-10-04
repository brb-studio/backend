import type { ObjectId } from "mongodb";
import type { BarberDoc, PackageDoc, ServiceDoc } from "../../db/scoped";

export const fitsBranch = (item: { branchId?: ObjectId }, branchId: ObjectId) =>
  !item.branchId || item.branchId.equals(branchId);

export function offers(
  barber: Pick<BarberDoc, "branchId" | "serviceIds" | "active">,
  services: Pick<ServiceDoc, "_id" | "branchId" | "active">[],
) {
  return (
    barber.active &&
    services.length > 0 &&
    services.every(
      (s) =>
        s.active &&
        fitsBranch(s, barber.branchId) &&
        barber.serviceIds.some((id) => id.equals(s._id)),
    )
  );
}

export function packageServices<S extends Pick<ServiceDoc, "_id">>(
  pkg: Pick<PackageDoc, "items">,
  services: S[],
): S[] | null {
  const byId = new Map(services.map((s) => [s._id.toHexString(), s]));
  const list = pkg.items.map((item) => byId.get(item.serviceId.toHexString()));
  return list.every((s): s is S => s !== undefined) ? list : null;
}

export const totals = (
  services: Pick<ServiceDoc, "durationMin" | "priceMinor">[],
) => ({
  durationMin: services.reduce((sum, s) => sum + s.durationMin, 0),
  listPriceMinor: services.reduce((sum, s) => sum + s.priceMinor, 0),
});

export type Request = {
  services: ServiceDoc[];
  pkg?: PackageDoc;
};

export const canServe = (
  barber: Pick<BarberDoc, "branchId" | "serviceIds" | "active">,
  request: Request,
) =>
  offers(barber, request.services) &&
  (!request.pkg || fitsBranch(request.pkg, barber.branchId));
