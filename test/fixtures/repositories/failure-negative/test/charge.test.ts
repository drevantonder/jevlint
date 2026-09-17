import { it, expect } from "vitest";
import { PaymentError, chargeCard } from "../src/charge.js";

it("maps gateway failure to PaymentError", async () => {
  await expect(chargeCard(-1)).rejects.toThrowError(PaymentError);
});
