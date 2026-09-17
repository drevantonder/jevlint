import { describe, expect, it } from "vitest";
import { total } from "../src/report.js";

describe("report", () => {
  it("counts lines", () => {
    expect(total(["a", "b"])).toBe(2);
  });
});
