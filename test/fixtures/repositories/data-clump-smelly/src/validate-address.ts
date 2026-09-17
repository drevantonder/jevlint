export function validateAddress(
  street: string,
  city: string,
  postalCode: string,
  country: string,
): boolean {
  return street.length > 0 && city.length > 0 && postalCode.length > 0 && country.length === 2;
}
