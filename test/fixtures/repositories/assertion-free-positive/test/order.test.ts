import { describe, expect, it } from "vitest";
import { process } from "../src/order.js";

describe("process", () => {
  it("computes the total for a valid order", () => {
    const receipt = process({ id: "o1", total: 40 });
    expect(receipt.total).toBe(40);
  });

  it("processes an order without surprises", () => {
    process({ id: "o2", total: 10 });
  });
});
