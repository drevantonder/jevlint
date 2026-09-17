import { Account, formatCents } from "./account.js";

export function receipt(account: Account, cents: number): string {
  account.deposit(cents);
  return formatCents(cents);
}
