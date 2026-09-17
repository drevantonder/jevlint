import { chargeOrder } from "./charge-order.js";

export async function checkout(orderId: string, paymentToken: string) {
  return chargeOrder(orderId, paymentToken);
}
