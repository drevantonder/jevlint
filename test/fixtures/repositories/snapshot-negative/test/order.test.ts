import { it, expect } from "vitest";
import { serializeOrder } from "../src/order.js";

it("serializes the order payload", () => {
  const payload = serializeOrder({ id: 7 });
  expect(payload).toMatchInlineSnapshot(`
    {
      "id": 7,
      "version": "v2",
    }
  `);
  expect(payload.version).toBe("v2");
});
