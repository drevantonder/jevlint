import { describe, expect, it } from "vitest";
import { increment } from "../src/index.js";

describe("store", () => {
  it("bumps the observable counter", () => {
    expect(increment()).toBe(1);
  });
});
