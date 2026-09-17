export function formatShippingLabel(
  street: string,
  city: string,
  postalCode: string,
  country: string,
  recipient: string,
): string {
  return `${recipient}\n${street}\n${city} ${postalCode}\n${country}`;
}
