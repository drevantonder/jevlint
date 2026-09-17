export interface Destination {
  country: string;
  postalCode: string;
}

export interface Item {
  sku: string;
  weightGrams: number;
}

export interface ShippingQuote {
  amountCents: number;
  service: string;
}

export async function requestShippingRate(
  destination: Destination,
  items: Item[],
): Promise<ShippingQuote> {
  const response = await fetch("https://rates.example/quotes", {
    method: "POST",
    body: JSON.stringify({ destination, items }),
  });
  if (!response.ok) throw new Error(`Rate service failed: ${response.status}`);
  return response.json() as Promise<ShippingQuote>;
}
