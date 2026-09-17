export async function placeOrder(command: PlaceOrder): Promise<PlaceOrderResult> {
  return ordering.place(command);
}
