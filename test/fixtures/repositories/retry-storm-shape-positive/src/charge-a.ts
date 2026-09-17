import { paymentGateway, sleep } from "./payment-gateway.js";

export async function chargeWithRetry(orderId: string, paymentToken: string) {
  while (true) {
    try {
      return await paymentGateway.charge({ orderId, paymentToken });
    } catch {
      await sleep(100);
    }
  }
}
