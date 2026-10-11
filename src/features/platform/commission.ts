/** Commission in basis points (1000 = 10%) of what the customer was charged, rounded half up to a minor unit. */
export const commissionOf = (totalMinor: number, bps: number) =>
  Math.floor((totalMinor * bps + 5_000) / 10_000);

type Commissionable = {
  status: string;
  totalMinor: number;
  commission?: { bps: number; amountMinor: number };
};

export function resolveCommission(
  appointment: Commissionable,
  barberBps: number | undefined,
) {
  if (appointment.status !== "completed") return null;
  if (appointment.commission) {
    return { ...appointment.commission, source: "snapshot" as const };
  }
  if (barberBps === undefined) return null;
  return {
    bps: barberBps,
    amountMinor: commissionOf(appointment.totalMinor, barberBps),
    source: "barber_config" as const,
  };
}
