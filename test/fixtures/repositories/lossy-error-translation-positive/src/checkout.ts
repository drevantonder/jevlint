import { chargeOrder } from "./charge-order.js";
import { GatewayUnavailableError, PaymentDeclinedError } from "./payment-gateway.js";

export async function submitOrder(orderId: string, paymentToken: string) {
  try {
    return await chargeOrder(orderId, paymentToken);
  } catch (error) {
    if (error instanceof PaymentDeclinedError) return { status: "choose-another-card" as const };
    if (error instanceof GatewayUnavailableError) return { status: "retry-later" as const };
    throw error;
  }
}
