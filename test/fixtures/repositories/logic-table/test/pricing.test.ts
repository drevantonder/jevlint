import { describe, expect, it } from "vitest";
import { discountRate } from "../src/pricing.js";

describe.each([
  { vip: true, expected: 0.2 },
  { vip: false, expected: 0 },
])("discountRate(%o)", ({ vip, expected }) => {
  it("returns the tabled rate", () => {
    expect(discountRate(vip)).toBe(expected);
  });
});
