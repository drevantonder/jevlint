import { transferFunds } from "../domain/transfer-funds.js";

export async function executeTransfer(command: TransferCommand) {
  await transferFunds(
    command.sourceAccountId,
    command.destinationAccountId,
    command.amountCents,
  );
}
