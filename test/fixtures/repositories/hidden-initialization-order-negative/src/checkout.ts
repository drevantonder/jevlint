import { chargeOrderExplicit } from "./charge-order-explicit.js";

export async function checkout(order: Order): Promise<Receipt> {
  return chargeOrderExplicit(order, paymentClient);
}
