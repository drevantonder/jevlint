export async function placeOrder(order: Order) {
  const reservation = await reserveInventory(order.items);
  const payment = await chargePayment(order.customerId, reservation.total);
  const confirmation = await confirmOrder(reservation.id, payment.id);
  return confirmation;
}
