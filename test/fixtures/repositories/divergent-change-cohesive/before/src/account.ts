export class Account {
  balanceCents = 0;

  deposit(cents: number): void {
    this.balanceCents += cents;
  }

  withdraw(cents: number): void {
    this.balanceCents -= cents;
  }
}
