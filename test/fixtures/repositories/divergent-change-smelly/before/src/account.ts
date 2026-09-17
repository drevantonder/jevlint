export class Account {
  name = "";
  balanceCents = 0;

  rename(name: string): void {
    this.name = name;
  }

  deposit(cents: number): void {
    this.balanceCents += cents;
  }
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
