import {
  GatewayUnavailableError,
  PaymentDeclinedError,
  paymentGateway,
} from "./payment-gateway.js";

export async function chargeOrder(orderId: string, paymentToken: string) {
  try {
    return await paymentGateway.charge({ orderId, paymentToken });
  } catch {
    throw new Error("Payment failed");
  }
}

export type ChargeFailure = PaymentDeclinedError | GatewayUnavailableError;
