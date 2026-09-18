export class OrderService {
  private orders: Map<string, number> = new Map();

  place(id: string, total: number): void {
    this.orders.set(id, total);
  }

  total(id: string): number {
    return this.orders.get(id) ?? 0;
  }
}
