import { it, expect, vi } from "vitest";
import { total, math } from "../src/calc.js";

it("sums rows", () => {
  const spy = vi.spyOn(math, "round");
  total([1, 2]);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith(3);
});
