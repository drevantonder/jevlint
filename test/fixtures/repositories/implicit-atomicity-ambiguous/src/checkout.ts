import { placeOrderSaga } from "./place-order-saga.js";

export async function checkout(order: Order): Promise<void> {
  await placeOrderSaga(order);
}
