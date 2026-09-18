export interface CartItem {
  sku: string;
  quantity: number;
}

export class Cart {
  private items: CartItem[] = [];
  private tags: string[] = [];
  private lookup = new Map<string, CartItem>();
  private snapshot: CartItem[] = [];

  replaceItems(items: CartItem[]): void {
    this.items = [...items];
  }

  resetTags(tags: string[]): void {
    this.tags = tags.slice();
  }

  remember(entry: CartItem): void {
    this.lookup.set(entry.sku, structuredClone(entry));
  }

  snapshotItems(items: CartItem[]): void {
    this.snapshot = Array.from(items);
  }
}
