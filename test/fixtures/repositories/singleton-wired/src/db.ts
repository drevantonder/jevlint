export type Order = { id: string; amount: number };

const connectionString = "postgres://localhost:5432/shop";

export function getDatabase(): { rateFor(orderId: string): number } {
  void connectionString;
  return { rateFor: () => 0.05 };
}
