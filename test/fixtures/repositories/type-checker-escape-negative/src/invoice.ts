export type Invoice = { id: string; total: number };

export function invoiceTotal(invoice: Invoice): number {
  return invoice.total;
}
