export async function fetchPayment(paymentId: string): Promise<Payment> {
  const response = await paymentsClient.get(`/payments/${paymentId}`);
  if (response.status === 401 || response.status === 403) {
    throw new PaymentsAuthenticationError(response.status);
  }
  return response.json();
}
