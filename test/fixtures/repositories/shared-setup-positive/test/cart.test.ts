import { beforeAll, describe, expect, it } from "vitest";

let cart: string[];

describe("cart", () => {
  let attempts: number;

  beforeAll(() => {
    cart = [];
    attempts = 0;
  });

  it("starts empty", () => {
    expect(cart).toHaveLength(0);
    expect(attempts).toBe(0);
  });

  it("records an attempt", () => {
    attempts += 1;
    cart.push("apple");
    expect(cart).toContain("apple");
  });
});
