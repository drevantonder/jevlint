import { describe, expect, it } from "vitest";
import { total } from "../src/cart.js";

describe("cart", () => {
  it("applies the quantity discount", () => {
    expect(total(100, 10)).toBe(800);
  });
});
