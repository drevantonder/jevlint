import { test } from "node:test";
import assert from "node:assert";
import { label } from "../../../app.js";

test("labels an order total through the app seam", () => {
  assert.strictEqual(label(5), "$0.05");
});
