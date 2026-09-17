import { receiptStore } from "./receipt-store.js";

export async function storeReceipt(orderId: string, receipt: string) {
  try {
    await receiptStore.put(orderId, receipt);
  } catch (error) {
    throw new Error(`Could not store receipt for ${orderId}`, { cause: error });
  }
}
