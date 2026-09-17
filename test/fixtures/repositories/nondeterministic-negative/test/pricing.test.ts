import { describe, expect, it } from "vitest";
import { priceWithDiscount } from "../src/pricing.js";

describe("pricing", () => {
  it("applies a fixed discount from known inputs", () => {
    const total = priceWithDiscount(100, 0.5, 1_700_000_000_000);
    expect(total).toBe(95);
  });
});
