export interface ShippingPolicy {
  peakSurcharge: number;
}

export function quoteShipping(weightKg: number, policy: ShippingPolicy): number {
  return weightKg * 2 + policy.peakSurcharge;
}
