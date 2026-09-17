import { OrderManager } from "./order-manager.js";

export function bill(manager: OrderManager, cents: number): number {
  manager.charge(cents);
  return manager.outstanding();
}
