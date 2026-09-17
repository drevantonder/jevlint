export async function transferFunds(
  sourceAccountId: string,
  destinationAccountId: string,
  amountCents: number,
) {
  const source = await accounts.get(sourceAccountId);
  const destination = await accounts.get(destinationAccountId);
  source.debit(amountCents);
  destination.credit(amountCents);
  await accounts.save(source, destination);
}
