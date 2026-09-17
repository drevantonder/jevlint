import { publishInvoice } from "./publish-invoice.js";

export async function finishBilling(invoiceId: string) {
  const publication = await publishInvoice(invoiceId);
  return publication.status === "published";
}
