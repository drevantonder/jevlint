import { describe, expect, it } from "vitest";
import { priceWithDiscount } from "../src/pricing.js";

describe("pricing", () => {
  it("applies a lucky discount drawn at checkout time", () => {
    const lucky = Math.random();
    const placedAt = Date.now();
    const total = priceWithDiscount(100, lucky, placedAt);
    expect(total).toBeGreaterThanOrEqual(90);
    expect(total).toBeLessThanOrEqual(100);
  });
});
