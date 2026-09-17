export interface Transfer {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
}

export async function transferFunds(transfer: Transfer): Promise<void> {
  await accounts.debit(transfer.fromAccountId, transfer.amount);
  await accounts.credit(transfer.toAccountId, transfer.amount);
}
