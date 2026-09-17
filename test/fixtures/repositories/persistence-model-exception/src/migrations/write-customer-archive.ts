import { exportLegacyCustomers } from "./export-legacy-customers.js";

export async function writeCustomerArchive(path: string) {
  const rows = await exportLegacyCustomers();
  await writeJsonLines(path, rows);
}
