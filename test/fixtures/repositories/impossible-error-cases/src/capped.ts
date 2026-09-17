import { readLimit } from "./risky.js";

export function capForPlan(plan: string): number {
  try {
    return readLimit(plan);
  } catch {
    return 1;
  }
}
