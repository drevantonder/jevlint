import { chargeWithRetry } from "./charge-a.js";

export async function checkout(orderId: string, paymentToken: string) {
  return chargeWithRetry(orderId, paymentToken);
}
