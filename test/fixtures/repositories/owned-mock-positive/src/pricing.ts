export function discountFor(quantity: number): number {
  if (quantity >= 10) return 0.2;
  if (quantity >= 5) return 0.1;
  return 0;
}
