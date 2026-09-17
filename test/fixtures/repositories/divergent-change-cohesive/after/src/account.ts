export class Account {
  balanceCents = 0;
  frozen = false;

  freeze(): void {
    this.frozen = true;
  }

  deposit(cents: number): void {
    this.balanceCents += cents;
  }

  withdraw(cents: number): void {
    if (this.frozen) throw new Error("frozen");
    this.balanceCents -= cents;
  }
}
