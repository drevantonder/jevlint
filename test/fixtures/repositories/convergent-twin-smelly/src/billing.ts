export type BillingInvoice = {
  id: string;
  accountId: string;
  status: string;
  issuedAt: string;
  dueAt: string;
  totalCents: number;
  currency: string;
  pdfUrl: string;
};

export function invoiceById(invoices: BillingInvoice[], id: string): BillingInvoice | undefined {
  return invoices.find((invoice) => invoice.id === id);
}
