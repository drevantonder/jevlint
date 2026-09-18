export type WireInvoice = {
  id: unknown;
  accountId: unknown;
  status: unknown;
  issuedAt: unknown;
  dueAt: unknown;
  totalCents: unknown;
  currency: unknown;
  pdfUrl: unknown;
};

export function wireInvoiceById(invoices: WireInvoice[], id: unknown): WireInvoice | undefined {
  return invoices.find((invoice) => invoice.id === id);
}
