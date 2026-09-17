import { receiptStore } from "./receipt-store.js";

export class ReceiptStorageError extends Error {
  readonly orderId: string;

  constructor(orderId: string, cause: unknown) {
    super(`Could not store receipt for order ${orderId}`, { cause });
    this.orderId = orderId;
  }
}

export async function storeReceipt(orderId: string, receipt: string) {
  try {
    await receiptStore.put(orderId, receipt);
  } catch (error) {
    throw new ReceiptStorageError(orderId, error);
  }
}
