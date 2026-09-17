import { Order } from "./order.js";

export function price(order: Order): number {
  let total = order.subtotal;
  if (order.couponCode !== undefined) {
    total = total * (1 - order.discountRate);
  }
  return total;
}
