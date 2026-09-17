import { describe, expect, it } from "vitest";
import { add } from "../src/math.js";

export function createCart(items: number[]): { items: number[] } {
  return { items };
}

describe("math", () => {
  it("adds two numbers", () => {
    expect(add(1, 2)).toBe(3);
  });
});
