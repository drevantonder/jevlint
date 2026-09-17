import { describe, expect, it } from "vitest";
import { discountRate } from "../src/pricing.js";

describe("discountRate", () => {
  it("matches the vip predicate before asserting", () => {
    const vip = true;
    let expected: number;
    if (vip) {
      expected = 0.2;
    } else {
      expected = 0;
    }
    expect(discountRate(vip)).toBe(expected);
  });
});
