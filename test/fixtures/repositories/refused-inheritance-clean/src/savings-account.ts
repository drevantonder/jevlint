import { Account } from "./account.js";

export class SavingsAccount extends Account {
  credit(cents: number): void {
    super.credit(cents);
  }

  project(years: number): number {
    this.debit(years);
    return this.statement();
  }
}
