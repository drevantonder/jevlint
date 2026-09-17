import { it, expect } from "vitest";
import { total } from "../src/calc.js";

it("sums rows", () => {
  expect(total([1, 2])).toBe(3);
});
