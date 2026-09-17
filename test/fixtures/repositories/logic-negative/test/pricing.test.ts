import { describe, expect, it } from "vitest";
import { discountRate } from "../src/pricing.js";

describe("discountRate", () => {
  it("gives vips twenty percent", () => {
    expect(discountRate(true)).toBe(0.2);
  });

  it("gives no discount otherwise", () => {
    expect(discountRate(false)).toBe(0);
  });
});
