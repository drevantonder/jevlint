import { gateway } from "./gateway.js";

export class PaymentError extends Error {}

export async function chargeCard(amount: number): Promise<string> {
  try {
    return await gateway.charge(amount);
  } catch (error) {
    throw new PaymentError("charge failed", { cause: error });
  }
}
