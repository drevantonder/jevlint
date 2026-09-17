import { GatewayUnavailableError, paymentGateway, sleep } from "./payment-gateway.js";

const retryPolicy = {
  maxAttempts: 3,
  backoffMs: 200,
};

export async function chargeOrder(orderId: string, paymentToken: string) {
  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
    try {
      return await paymentGateway.charge({
        orderId,
        paymentToken,
        idempotencyKey: orderId,
      });
    } catch (error) {
      const exhausted = attempt === retryPolicy.maxAttempts;
      if (!(error instanceof GatewayUnavailableError) || exhausted) throw error;
      await sleep(retryPolicy.backoffMs * attempt);
    }
  }

  throw new Error("Unreachable retry state");
}
