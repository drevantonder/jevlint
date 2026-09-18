import { expect, it } from "vitest";
import { formatCents } from "../helper.js";

it("prices through the shared helper", () => {
  expect(formatCents(199)).toBe("1.99");
});
