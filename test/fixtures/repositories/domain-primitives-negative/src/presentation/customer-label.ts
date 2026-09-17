import { formatDisplayName } from "./format-display-name.js";

export function customerLabel(customer: Customer): string {
  return formatDisplayName(customer.givenName, customer.familyName);
}
