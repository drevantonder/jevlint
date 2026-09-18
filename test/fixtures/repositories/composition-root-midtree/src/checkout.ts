import { processOrder } from "./orders.js";
import type { Order } from "./store.js";

export function retryOrder(order: Order): void {
  try {
    processOrder(order);
  } catch {
    processOrder(order);
  }
}
