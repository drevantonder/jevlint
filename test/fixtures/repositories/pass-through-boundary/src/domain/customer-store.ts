import { persistenceClient } from "@acme/persistence-sdk";

export function persistCustomer(customer: Customer) {
  return persistenceClient.persistCustomer(customer);
}
