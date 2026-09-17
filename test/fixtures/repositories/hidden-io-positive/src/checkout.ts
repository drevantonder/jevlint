import { calculateShippingQuote } from "./calculate-shipping-quote.js";

interface Order {
  destination: { country: string; postalCode: string };
  items: Array<{ sku: string; weightGrams: number }>;
}

export async function showCheckout(order: Order): Promise<number> {
  const quote = await calculateShippingQuote(order.destination, order.items);
  return quote.amountCents;
}
