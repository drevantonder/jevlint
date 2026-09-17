import { taxRules } from "@acme/tax-rules";

interface Order {
  destination: string;
  subtotalCents: number;
}

export async function resolveTax(order: Order): Promise<number> {
  return await taxRules.evaluate(order);
}
