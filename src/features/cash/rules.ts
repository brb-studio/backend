import type { COUNTER_METHODS, PRODUCT_PAYMENT_METHODS } from "../../db/scoped";

export type CounterMethod = (typeof COUNTER_METHODS)[number];

export type Movement = {
  kind: "cut" | "product";
  source: "counter" | "transfer";
  method: CounterMethod;
  amountMinor: number;
  receivedBy: string;
  customerId: string;
  at: Date;
  timeZone: string;
  reference?: string;
  visitAt?: Date;
};

type ByMethod = Record<CounterMethod, number>;

const empty = (): ByMethod => ({ cash: 0, card: 0, transfer: 0 });

export const productMethod = (
  method: (typeof PRODUCT_PAYMENT_METHODS)[number],
): CounterMethod => (method === "spei" ? "transfer" : method);

export const inMinor = (sums: ByMethod) => ({
  cashMinor: sums.cash,
  cardMinor: sums.card,
  transferMinor: sums.transfer,
});

export function summarize(movements: Movement[]) {
  const totals = empty();
  const people = new Map<string, ByMethod>();
  for (const m of movements) {
    totals[m.method] += m.amountMinor;
    const person = people.get(m.receivedBy) ?? empty();
    person[m.method] += m.amountMinor;
    people.set(m.receivedBy, person);
  }
  return { totals, people };
}
