import { describe, expect, it, vi } from "vitest";

vi.mock("../src/removed.js", () => ({
  helper: vi.fn(() => 1),
}));

import { total } from "../src/cart.js";

describe("cart", () => {
  it("totals the lines", () => {
    expect(total(100, 1)).toBe(100);
  });
});
