import { shipBatches } from "./plan.js";

export function checkout(items: string[]): number {
  return shipBatches(items.map((item) => [item]));
}
