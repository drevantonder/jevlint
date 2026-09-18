import assert from "node:assert";
import { describe, expect, it } from "vitest";
import { add, STATUS } from "../src/math";

describe("math", () => {
  it("adds two numbers", () => {
    const a = 2;
    const b = 3;
    expect(add(a, b)).toBe(a + b);
  });

  it("sums through node assert", () => {
    const a = 2;
    const b = 3;
    assert.strictEqual(add(a, b), a + b);
  });

  it("reports status against itself", () => {
    expect(STATUS).toBe(STATUS);
  });
});
