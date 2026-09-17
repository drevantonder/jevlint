export interface Item {
  weightGrams: number;
}

export function calculateShippingQuote(items: Item[]): number {
  const totalWeight = items.reduce((sum, item) => sum + item.weightGrams, 0);
  return 500 + Math.ceil(totalWeight / 1_000) * 125;
}
