export interface CartItem {
  sku: string;
  quantity: number;
}

export function totalQuantity(items: CartItem[]): number {
  const working = items;
  return working.reduce((sum, item) => sum + item.quantity, 0);
}

export function firstSku(items: CartItem[]): string | undefined {
  const queue = items.slice();
  return queue.shift()?.sku;
}
