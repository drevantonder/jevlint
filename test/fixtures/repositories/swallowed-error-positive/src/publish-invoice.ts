import { invoiceEvents, invoices, logger } from "./services.js";

export async function publishInvoice(invoiceId: string) {
  const invoice = await invoices.load(invoiceId);
  try {
    await invoiceEvents.publish({ type: "invoice.published", invoice });
  } catch (error) {
    logger.error("Could not publish invoice event", { error, invoiceId });
  }

  await invoices.markPublished(invoiceId);
  return { invoiceId, status: "published" as const };
}
