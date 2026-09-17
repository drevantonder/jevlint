export class ShoppingCart {
  private items: string[] = [];

  add(item: string): void {
    this.items.push(item);
  }

  remove(item: string): void {
    this.items = this.items.filter((entry) => entry !== item);
  }

  count(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }
}
