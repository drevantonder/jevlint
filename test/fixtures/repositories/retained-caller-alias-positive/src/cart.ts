export interface CartItem {
  sku: string;
  quantity: number;
}

export class Cart {
  private items: CartItem[] = [];
  private index = new Map<string, CartItem[]>();

  setItems(items: CartItem[]): void {
    this.items = items;
  }

  indexBySku(sku: string, entries: CartItem[]): void {
    this.index.set(sku, entries);
  }
}
