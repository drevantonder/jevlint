import type { Order } from "./db.js";

export function priceOrder(order: Order, rate: number): number {
  return order.amount - order.amount * rate;
}
