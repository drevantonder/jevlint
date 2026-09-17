import { transferFundsTransactional } from "./transfer-funds-transactional.js";

export async function postTransfer(request: TransferRequest): Promise<void> {
  await transferFundsTransactional(request.transfer);
}
