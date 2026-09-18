import { logger, payments } from "./services.js";

// Refund helpers settle a payment and report what happened.
// Records the failure locally and propagates the same error: one failure
// handled twice when the caller records it again.
export async function refundPayment(paymentId: string) {
  try {
    await payments.refund(paymentId);
  } catch (error) {
    logger.error("refund failed", { paymentId, error });
    throw error;
  }
  return { paymentId, status: "refunded" as const };
}

export function refundPaymentLater(paymentId: string): Promise<unknown> {
  return payments.refund(paymentId).catch((error: unknown) => {
    logger.error("refund failed", { paymentId, error });
    throw error;
  });
}
