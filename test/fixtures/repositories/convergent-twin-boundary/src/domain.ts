export type DomainInvoice = {
  id: string;
  accountId: string;
  status: string;
  issuedAt: string;
  dueAt: string;
  totalCents: number;
  currency: string;
  pdfUrl: string;
};

export function invoiceTotal(invoice: DomainInvoice): number {
  return invoice.totalCents;
}
