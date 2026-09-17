export function process(order: { id: string; total: number }): { total: number } {
  return { total: order.total };
}
