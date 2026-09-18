import { describe, expect, it, vi } from "vitest";

vi.mock("../src/pricing.js", () => ({
  discountFor: vi.fn(() => 0.5),
}));

import { total } from "../src/cart.js";

describe("cart", () => {
  it("applies the mocked discount", () => {
    expect(total(100, 2)).toBe(100);
  });
});
