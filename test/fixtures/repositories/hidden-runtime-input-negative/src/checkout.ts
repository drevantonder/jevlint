import { quoteShipping } from "./quote-shipping-with-policy.js";

export function checkoutShipping(weightKg: number): number {
  return quoteShipping(weightKg, { peakSurcharge: 5 });
}
