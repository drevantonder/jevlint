import { getDatabase } from "./db.js";
import { priceOrder } from "./pricing.js";
import type { Order } from "./db.js";

export function wireOrderTotal(order: Order): number {
  const db = getDatabase();
  return priceOrder(order, db.rateFor(order.id));
}
