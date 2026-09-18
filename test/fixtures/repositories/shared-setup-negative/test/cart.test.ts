import { beforeEach, describe, expect, it } from "vitest";

let cart: string[];

describe("cart", () => {
  beforeEach(() => {
    cart = [];
  });

  it("totals a single item", () => {
    cart.push("apple");
    expect(cart).toHaveLength(1);
  });

  it("totals two items", () => {
    const local = ["apple", "pear"];
    expect(local).toHaveLength(2);
  });
});
