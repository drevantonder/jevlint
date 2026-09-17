import { lookupRate } from "./store.js";

export function priceForPlan(plan: string): number {
  try {
    return lookupRate(plan) * 2;
  } catch {
    return 0;
  }
}
