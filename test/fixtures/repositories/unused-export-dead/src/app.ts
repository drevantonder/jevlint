import { liveTotal } from "./totals.js";

export function checkoutTotal(items: number[]): string {
  return `Total: ${liveTotal(items)}`;
}
