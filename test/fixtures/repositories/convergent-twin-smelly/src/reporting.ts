export type ReportingInvoice = {
  id: string;
  accountId: string;
  status: string;
  issuedAt: string;
  dueAt: string;
  totalCents: number;
  currency: string;
  pdfUrl: string;
};

export function reportRow(invoice: ReportingInvoice): string {
  return `${invoice.id} ${invoice.status} ${invoice.totalCents}`;
}
