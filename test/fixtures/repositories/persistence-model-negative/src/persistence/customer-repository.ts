import { Customer } from "../domain/customer.js";
import { prisma } from "./prisma.js";

export async function loadCustomer(customerId: string): Promise<Customer | null> {
  const row = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!row) return null;
  return Customer.restore({
    id: row.id,
    creditLimitCents: row.credit_limit_cents,
    riskBand: row.risk_band_code,
  });
}
