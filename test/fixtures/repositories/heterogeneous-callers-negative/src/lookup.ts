export type Account = { id: string; owner: string };

const accounts: Account[] = [];

export function lookupAccount(id: string): Account | undefined {
  return accounts.find((account) => account.id === id);
}
