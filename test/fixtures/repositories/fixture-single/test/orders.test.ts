import { beforeEach, describe, expect, it } from "vitest";

describe("orders", () => {
  let order: { id: string; total: number };

  beforeEach(() => {
    order = { id: "o1", total: 40 };
  });

  it("computes the total", () => {
    expect(order.total).toBe(40);
  });
});
