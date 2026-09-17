import { paymentGateway } from "./payment-gateway.js";

export async function receipt(orderId: string, paymentToken: string) {
  return paymentGateway.charge({ orderId, paymentToken });
}
