import { quoteShipping } from "./quote-shipping.js";

export function checkoutShipping(weightKg: number): number {
  return quoteShipping({ weightKg });
}
