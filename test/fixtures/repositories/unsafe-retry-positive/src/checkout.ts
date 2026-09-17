import { chargeOrder } from "./charge-order.js";

export async function checkout(orderId: string, paymentToken: string) {
  const payment = await chargeOrder(orderId, paymentToken);
  return { orderId, transactionId: payment.transactionId };
}
