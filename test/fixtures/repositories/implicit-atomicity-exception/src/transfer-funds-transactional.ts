export async function transferFundsTransactional(transfer: Transfer): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.debit(transfer.fromAccountId, transfer.amount);
    await transaction.credit(transfer.toAccountId, transfer.amount);
  });
}
