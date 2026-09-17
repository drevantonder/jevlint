let paymentClient: PaymentClient;

export function configurePayments(client: PaymentClient): void {
  paymentClient = client;
}

export async function chargeOrder(order: Order): Promise<Receipt> {
  return paymentClient.charge(order.id, order.total);
}
