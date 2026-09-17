export interface ShippingEnvironment {
  peakSurcharge: number;
}

export function loadShippingEnvironment(): ShippingEnvironment {
  return {
    peakSurcharge: process.env.PEAK_SHIPPING === "1" ? 5 : 0,
  };
}
