import { OrderManager } from "./order-manager.js";

export function dispatch(manager: OrderManager, id: string): string[] {
  manager.ship(id);
  return manager.shipped();
}
