import { placeOrder } from "./orders.js";

export function handleCheckout(id: string) {
  return placeOrder(id);
}
