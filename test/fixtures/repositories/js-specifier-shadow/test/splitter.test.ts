import { describe, expect, it } from "vitest";
import { splitter } from "../src/splitter.js";

describe("splitter", () => {
  it("copies parts", () => {
    expect(splitter(["a"])).toEqual(["a"]);
  });
});
