import type { CustomerRecord } from "../repositories/customer-record.js";
import { customerRecords } from "../repositories/customer-records.js";

export async function findCustomer(customerId: string): Promise<CustomerRecord | null> {
  return customerRecords.find(customerId);
}
