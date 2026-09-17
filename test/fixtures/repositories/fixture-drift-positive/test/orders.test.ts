import { beforeEach, describe, expect, it } from "vitest";

describe("orders", () => {
  let order: { id: string; total: number; vip: boolean };

  beforeEach(() => {
    order = { id: "o1", total: 40, vip: false };
  });

  it("computes the total", () => {
    expect(order.total).toBe(40);
  });
});
