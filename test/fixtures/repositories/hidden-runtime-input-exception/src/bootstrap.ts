import { loadShippingEnvironment } from "./load-shipping-environment.js";

export function bootstrapShipping(): void {
  const environment = loadShippingEnvironment();
  startShippingService(environment);
}
