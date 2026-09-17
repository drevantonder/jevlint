export class Account {
  balanceCents = 0;

  credit(cents: number): void {
    this.balanceCents += cents;
  }

  debit(cents: number): void {
    this.balanceCents -= cents;
  }

  statement(): number {
    return this.balanceCents;
  }
}
