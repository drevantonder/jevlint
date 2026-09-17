import { findCustomer } from "./find-customer.js";

export async function showCustomer(customerId: string) {
  const customer = await findCustomer(customerId);
  return customer ? { id: customer.id, name: customer.name } : null;
}
