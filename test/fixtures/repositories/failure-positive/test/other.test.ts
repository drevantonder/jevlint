import { it, expect } from "vitest";
import { gateway } from "../src/gateway.js";

it("charges positive amounts", async () => {
  await expect(gateway.charge(5)).resolves.toBe("receipt:5");
});
