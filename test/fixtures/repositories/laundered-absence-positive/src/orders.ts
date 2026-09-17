export interface OrderBook {
  orders: string[];
}

export function visibleOrders(book: OrderBook): string[] {
  const orders = book.orders ?? [];
  return orders;
}
