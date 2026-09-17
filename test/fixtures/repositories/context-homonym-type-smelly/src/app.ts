import type { Invoice as BillingInvoice } from "./billing";
import type { Invoice as ShippingInvoice } from "./shipping";

export function reconcile(billing: BillingInvoice, shipping: ShippingInvoice): string {
  return `${billing.number}:${shipping.trackingId}`;
}
