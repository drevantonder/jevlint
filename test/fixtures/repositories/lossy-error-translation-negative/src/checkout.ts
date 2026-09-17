import { ReceiptStorageError, storeReceipt } from "./store-receipt.js";

export async function completeCheckout(orderId: string, receipt: string) {
  try {
    await storeReceipt(orderId, receipt);
    return { stored: true };
  } catch (error) {
    if (error instanceof ReceiptStorageError) {
      return { stored: false, orderId: error.orderId, cause: error.cause };
    }
    throw error;
  }
}
