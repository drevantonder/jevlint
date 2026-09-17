import { persistCustomer } from "../domain/customer-store.js";

export async function registerCustomer(customer: Customer) {
  await persistCustomer(customer);
  return customer.id;
}
