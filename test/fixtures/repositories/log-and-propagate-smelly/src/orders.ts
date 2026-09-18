import { refundPayment } from "./refund.js";

export async function cancelOrder(orderId: string, paymentId: string) {
  await refundPayment(paymentId);
  return { orderId, status: "cancelled" as const };
}
