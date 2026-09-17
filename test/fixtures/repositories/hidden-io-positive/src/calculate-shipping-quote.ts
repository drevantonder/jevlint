import { requestShippingRate } from "./shipping-gateway.js";
import type { Destination, Item, ShippingQuote } from "./shipping-gateway.js";

export async function calculateShippingQuote(
  destination: Destination,
  items: Item[],
): Promise<ShippingQuote> {
  return await requestShippingRate(destination, items);
}
