import { paymentGateway, sleepWithBackoff } from "./payment-gateway.js";

const maxAttempts = 3;

export async function chargeWithPolicy(orderId: string, paymentToken: string) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await paymentGateway.charge({ orderId, paymentToken });
    } catch (error) {
      if (error instanceof Error && error.message.includes("declined")) throw error;
      await sleepWithBackoff(attempt);
    }
  }

  throw new Error("Payment failed");
}
