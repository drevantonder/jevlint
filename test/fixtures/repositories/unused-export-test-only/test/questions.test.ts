import { describe, expect, it } from "vitest";
import { planBatches } from "../src/plan.js";

describe("plan", () => {
  it("batches single items", () => {
    expect(planBatches(["a"])).toEqual([["a"]]);
  });
});
