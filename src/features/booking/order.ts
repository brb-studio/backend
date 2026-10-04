import type { AppointmentItem } from "../../db/scoped";
import { type Request, totals } from "../catalog/rules";

export const MAX_DURATION_MIN = 720;

export function snapshot(request: Request) {
  const { durationMin, listPriceMinor } = totals(request.services);
  const [first] = request.services;
  if (request.pkg) {
    const items: AppointmentItem[] = [
      {
        kind: "package",
        packageId: request.pkg._id,
        name: request.pkg.name,
        durationMin,
        priceMinor: request.pkg.priceMinor,
        services: request.services.map((s) => ({
          serviceId: s._id,
          name: s.name,
          durationMin: s.durationMin,
          listPriceMinor: s.priceMinor,
        })),
      },
    ];
    return {
      items,
      durationMin,
      subtotalMinor: request.pkg.priceMinor,
      item: { kind: "package" as const, id: request.pkg._id },
    };
  }
  if (!first) throw new Error("a request always has at least one service");
  const items: AppointmentItem[] = [
    {
      kind: "service",
      serviceId: first._id,
      name: first.name,
      durationMin,
      priceMinor: listPriceMinor,
    },
  ];
  return {
    items,
    durationMin,
    subtotalMinor: listPriceMinor,
    item: { kind: "service" as const, id: first._id },
  };
}

export const bookedMinutes = (items: AppointmentItem[]) =>
  items.reduce((sum, item) => sum + item.durationMin, 0);

export const bookedServiceIds = (items: AppointmentItem[]) =>
  items.flatMap((item) =>
    item.kind === "service"
      ? [item.serviceId]
      : item.services.map((s) => s.serviceId),
  );
