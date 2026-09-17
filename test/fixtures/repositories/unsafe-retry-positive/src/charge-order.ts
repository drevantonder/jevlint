import { paymentGateway, sleep } from "./payment-gateway.js";

export async function chargeOrder(orderId: string, paymentToken: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await paymentGateway.charge({ orderId, paymentToken });
    } catch {
      await sleep(100);
    }
  }

  throw new Error("Payment failed");
}
