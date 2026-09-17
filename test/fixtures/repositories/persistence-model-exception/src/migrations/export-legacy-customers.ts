import type { LegacyCustomerRow } from "../persistence/legacy-schema.js";
import { legacyDatabase } from "../persistence/legacy-database.js";

export async function exportLegacyCustomers(): Promise<LegacyCustomerRow[]> {
  return legacyDatabase.query("select * from legacy_customers order by legacy_id");
}
