import { paymentGateway } from "./payment-gateway.js";

export async function rebillWithRetry(orderId: string, paymentToken: string) {
  while (true) {
    try {
      return await paymentGateway.charge({ orderId, paymentToken });
    } catch {
      continue;
    }
  }
}
