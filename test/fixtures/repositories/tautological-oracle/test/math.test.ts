import { describe, expect, it } from "vitest";
import { add } from "../src/math";

describe("math", () => {
  it("adds two numbers to a worked total", () => {
    expect(add(1, 2)).toBe(3);
  });
});
