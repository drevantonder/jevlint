export async function capturePayment(paymentId: string): Promise<void> {
  await payments.capture(paymentId);
}
