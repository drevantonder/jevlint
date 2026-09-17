import { loadCustomer } from "../application/load-customer.js";

export async function assessCredit(customerId: string) {
  const customer = await loadCustomer(customerId);
  if (!customer || customer.deleted_at !== null) return "ineligible";
  return customer.credit_limit_cents > 100_000 && customer.risk_band_code !== "high"
    ? "eligible"
    : "manual-review";
}
