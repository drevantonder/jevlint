import { describe, expect, it, vi } from "vitest";

vi.mock("../src/discount.js", () => ({
  discountRate: vi.fn(() => 0.1),
}));

import { calculateFee } from "../src/fee.js";

describe("fee", () => {
  it("computes the discounted fee", () => {
    expect(calculateFee(100)).toBe(90);
  });
});
