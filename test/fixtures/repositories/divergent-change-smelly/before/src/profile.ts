import { Account } from "./account.js";

export function nickname(account: Account, name: string): string {
  account.rename(name);
  return name;
}
