import { chargeOrder } from "./payments.js";

export async function checkout(order: Order): Promise<Receipt> {
  return chargeOrder(order);
}
