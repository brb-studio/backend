import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { offers, packageServices, totals } from "./rules";

const centro = new ObjectId();
const norte = new ObjectId();
const service = (durationMin: number, priceMinor: number, extra = {}) => ({
  _id: new ObjectId(),
  active: true,
  durationMin,
  priceMinor,
  ...extra,
});
const corte = service(45, 30_000);
const barba = service(30, 20_000);
const masaje = service(30, 25_000);
const diseno = service(15, 10_000, { branchId: norte });

describe("totals", () => {
  test("Corte + Barba = 75 min; + Masaje = 105 min, list price $750", () => {
    expect(totals([corte, barba])).toEqual({
      durationMin: 75,
      listPriceMinor: 50_000,
    });
    expect(totals([corte, barba, masaje])).toEqual({
      durationMin: 105,
      listPriceMinor: 75_000,
    });
  });
});

describe("packageServices", () => {
  test("keeps item order and repeats; null when a service is missing", () => {
    const items = (...list: { _id: ObjectId }[]) => ({
      items: list.map((s) => ({ serviceId: s._id })),
    });
    expect(packageServices(items(barba, corte, corte), [corte, barba])).toEqual(
      [barba, corte, corte],
    );
    expect(packageServices(items(corte, masaje), [corte, barba])).toBeNull();
  });
});

describe("offers", () => {
  const barber = (serviceIds: ObjectId[], extra = {}) => ({
    branchId: centro,
    serviceIds,
    active: true,
    ...extra,
  });

  test("needs every service on the barber's list", () => {
    expect(offers(barber([corte._id, barba._id]), [corte, barba])).toBe(true);
    expect(offers(barber([corte._id]), [corte, barba])).toBe(false);
    expect(offers(barber([corte._id]), [])).toBe(false);
  });

  test("an inactive barber or service, or a service of another branch, is never offered", () => {
    expect(offers(barber([corte._id], { active: false }), [corte])).toBe(false);
    expect(offers(barber([corte._id]), [{ ...corte, active: false }])).toBe(
      false,
    );
    expect(offers(barber([diseno._id]), [diseno])).toBe(false);
    expect(offers(barber([diseno._id], { branchId: norte }), [diseno])).toBe(
      true,
    );
  });
});
