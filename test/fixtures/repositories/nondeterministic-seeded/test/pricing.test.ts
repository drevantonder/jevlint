import { describe, expect, it, vi } from "vitest";
import { priceWithDiscount } from "../src/pricing.js";

vi.useFakeTimers();
vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

describe("pricing", () => {
  it("applies a seeded discount deterministically", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const lucky = Math.random();
    const total = priceWithDiscount(100, lucky, Date.now());
    expect(total).toBe(95);
  });
});
