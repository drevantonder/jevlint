export interface Order {
  weightKg: number;
}

export function quoteShipping(order: Order): number {
  const peakSurcharge = process.env.PEAK_SHIPPING === "1" ? 5 : 0;
  return order.weightKg * 2 + peakSurcharge;
}
