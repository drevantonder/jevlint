import { discountFor } from "./pricing.js";

export function total(unitPrice: number, quantity: number): number {
  return unitPrice * quantity * (1 - discountFor(quantity));
}
