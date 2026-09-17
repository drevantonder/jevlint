export type InvoiceItem = {
  price: number;
  quantity: number;
};

export function invoiceTotal(items: InvoiceItem[], taxRate: number): number {
  let total = 0;
  for (const item of items) {
    total += item.price * item.quantity;
  }
  total += total * taxRate;
  return Math.round(total * 100) / 100;
}

export function invoiceTotalWithDiscount(
  items: InvoiceItem[],
  taxRate: number,
  discount: number,
): number {
  let total = 0;
  for (const item of items) {
    total += item.price * item.quantity;
  }
  total -= discount;
  total += total * taxRate;
  return Math.round(total * 100) / 100;
}
