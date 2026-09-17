import { describe, expect, it } from "vitest";
import { calculateFee } from "../src/fee.js";

describe("fee contract", () => {
  it("never charges a negative fee", () => {
    expect(calculateFee(0)).toBeGreaterThanOrEqual(0);
  });
});
