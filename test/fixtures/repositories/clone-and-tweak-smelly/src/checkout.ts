import { invoiceTotal, invoiceTotalWithDiscount } from "./invoices.js";
import type { InvoiceItem } from "./invoices.js";

export function checkout(items: InvoiceItem[], coupon: number | null): number {
  if (coupon === null) return invoiceTotal(items, 0.2);
  return invoiceTotalWithDiscount(items, 0.2, coupon);
}
