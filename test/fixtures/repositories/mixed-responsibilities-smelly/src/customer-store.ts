import type { ProfileInput } from "./update-profile.js";

export async function saveCustomer(input: ProfileInput): Promise<void> {
  await database.customers.update(input.customerId, { displayName: input.displayName });
}
