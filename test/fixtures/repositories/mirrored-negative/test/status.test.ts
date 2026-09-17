import { describe, expect, it } from "vitest";
import { currentStatus } from "../src/status";

describe("status", () => {
  it("reports the active code", () => {
    expect(currentStatus()).toBe("ACTIVE_V1");
  });
});
