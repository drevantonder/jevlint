import { it, expect } from "vitest";
import { total } from "../src/calc.js";

it.skip("sums rows with negatives", () => {
  expect(total([-1, 2])).toBe(1);
});
