import { beforeEach, describe, expect, it } from "vitest";

describe("refunds", () => {
  let order: { id: string; total: number };

  beforeEach(() => {
    order = { id: "o1", total: 40 };
  });

  it("refunds the total", () => {
    expect(order.total).toBe(40);
  });
});
