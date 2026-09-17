export async function chargeOrderExplicit(
  order: Order,
  paymentClient: PaymentClient,
): Promise<Receipt> {
  return paymentClient.charge(order.id, order.total);
}
