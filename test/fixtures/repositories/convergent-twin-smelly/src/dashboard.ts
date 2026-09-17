import type { BillingInvoice } from "./billing.js";
import type { ReportingInvoice } from "./reporting.js";

export function mergeInvoices(
  billed: BillingInvoice[],
  reported: ReportingInvoice[],
): string[] {
  return [...billed.map((invoice) => invoice.id), ...reported.map((invoice) => invoice.id)];
}
