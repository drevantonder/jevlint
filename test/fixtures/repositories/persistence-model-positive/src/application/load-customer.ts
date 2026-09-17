import type { Customer as CustomerRow } from "@prisma/client";
import { prisma } from "../persistence/prisma.js";

export async function loadCustomer(customerId: string): Promise<CustomerRow | null> {
  return prisma.customer.findUnique({ where: { id: customerId } });
}
