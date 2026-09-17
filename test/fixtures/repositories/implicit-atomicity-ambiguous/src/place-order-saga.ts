export async function placeOrderSaga(order: Order): Promise<void> {
  await inventory.reserve(order.id, order.items);
  try {
    await payments.charge(order.id, order.total);
  } catch (error) {
    await inventory.release(order.id, order.items);
    throw error;
  }
}
