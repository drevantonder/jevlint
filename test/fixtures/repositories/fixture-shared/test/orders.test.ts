import { describe, expect, it } from "vitest";
import { createOrder } from "../src/order-factory.js";

describe("orders", () => {
  it("computes the total", () => {
    expect(createOrder(40).total).toBe(40);
  });
});
