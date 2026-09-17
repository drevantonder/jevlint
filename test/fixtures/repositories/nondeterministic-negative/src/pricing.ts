export function priceWithDiscount(amount: number, lucky: number, placedAt: number): number {
  void placedAt;
  return amount - amount * 0.1 * lucky;
}
