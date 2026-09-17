import { OrderManager } from "./order-manager.js";

export function openOrder(manager: OrderManager, id: string): number {
  manager.addOrder(id);
  return manager.orderCount();
}
