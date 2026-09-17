import type { CheckoutFeatureFlags } from "./checkout-flags.js";

export function checkoutSections(flags: CheckoutFeatureFlags): string[] {
  const sections = ["address", "payment"];
  if (flags.showDeliveryEstimate) sections.push("delivery-estimate");
  if (flags.enableGiftMessage) sections.push("gift-message");
  if (flags.collectTaxId) sections.push("tax-id");
  if (flags.useExpressCheckout) sections.push("express-confirmation");
  return sections;
}
