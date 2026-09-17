import { placeOrder } from "./place-order.js";

export function checkout(order: Order) {
  return placeOrder(order);
}
