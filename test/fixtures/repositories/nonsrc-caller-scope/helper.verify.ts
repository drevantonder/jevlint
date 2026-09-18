import { expect, it } from "vitest";
import { formatCents } from "./helper.js";

it("formats cents without a filename segment", () => {
  expect(formatCents(5)).toBe("0.05");
});
