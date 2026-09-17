export interface CheckoutFeatureFlags {
  useExpressCheckout: boolean;
  showDeliveryEstimate: boolean;
  enableGiftMessage: boolean;
  collectTaxId: boolean;
}

export const checkoutFeatureFlags: CheckoutFeatureFlags = {
  useExpressCheckout: false,
  showDeliveryEstimate: true,
  enableGiftMessage: true,
  collectTaxId: false,
};
