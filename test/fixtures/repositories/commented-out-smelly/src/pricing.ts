export function priceLabel(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// function oldPriceLabel(cents: number): string {
//   const dollars = Math.floor(cents / 100);
//   const rest = cents % 100;
//   return "$" + dollars + "." + String(rest).padStart(2, "0");
// }

// Keep this helper so callers do not depend on the vendor API.
export function shippingLabel(cents: number): string {
  return `Shipping: ${priceLabel(cents)}`;
}
