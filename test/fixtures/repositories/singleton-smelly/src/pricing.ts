import { getDatabase } from "./db.js";
import type { Order } from "./db.js";

export function priceOrder(order: Order): number {
  const db = getDatabase();
  const rate = db.rateFor(order.id);
  return order.amount - order.amount * rate;
}
