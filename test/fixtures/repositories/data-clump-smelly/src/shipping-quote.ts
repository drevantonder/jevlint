export function calculateShippingQuote(
  street: string,
  city: string,
  postalCode: string,
  country: string,
  weight: number,
): number {
  return carrier.quote({ street, city, postalCode, country, weight });
}
