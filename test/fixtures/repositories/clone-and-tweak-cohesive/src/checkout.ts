import { invoiceTotal } from "./invoices.js";
import type { InvoiceItem } from "./invoices.js";

export function checkout(items: InvoiceItem[]): number {
  return invoiceTotal(items, 0.2);
}
