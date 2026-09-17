export async function markFulfilled(orderId: string, shipmentId: string): Promise<void> {
  await orders.update(orderId, { status: "fulfilled", shipmentId });
}
