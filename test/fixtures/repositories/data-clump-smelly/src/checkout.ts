import { calculateShippingQuote } from "./shipping-quote.js";

export function checkout(form: {
  street: string;
  city: string;
  postalCode: string;
  country: string;
  weight: number;
}): number {
  return calculateShippingQuote(
    form.street,
    form.city,
    form.postalCode,
    form.country,
    form.weight,
  );
}
