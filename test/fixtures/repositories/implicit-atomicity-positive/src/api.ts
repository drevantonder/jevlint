import { transferFunds } from "./transfer-funds.js";

export async function postTransfer(request: TransferRequest): Promise<void> {
  await transferFunds(request.transfer);
}
