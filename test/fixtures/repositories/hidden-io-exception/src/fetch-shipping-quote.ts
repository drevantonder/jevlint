export interface ShippingQuote {
  amountCents: number;
}

export async function fetchShippingQuote(orderId: string): Promise<ShippingQuote> {
  const response = await fetch(`/api/orders/${orderId}/shipping-quote`);
  if (!response.ok) throw new Error(`Could not fetch shipping quote: ${response.status}`);
  return response.json() as Promise<ShippingQuote>;
}
