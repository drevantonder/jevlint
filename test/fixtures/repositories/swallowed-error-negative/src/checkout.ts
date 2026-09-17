import { storeReceipt } from "./store-receipt.js";

export async function completeCheckout(orderId: string, receipt: string) {
  await storeReceipt(orderId, receipt);
  return { orderId, completed: true };
}
