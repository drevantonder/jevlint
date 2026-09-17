import { loadCustomer } from "../persistence/customer-repository.js";

export async function assessCredit(customerId: string) {
  const customer = await loadCustomer(customerId);
  return customer?.riskBand === "high" ? "manual-review" : "eligible";
}
