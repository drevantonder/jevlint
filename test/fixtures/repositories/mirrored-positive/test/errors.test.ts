import { describe, expect, it } from "vitest";
import { limitError } from "../src/errors";

describe("errors", () => {
  it("reports the rate limit code", () => {
    expect(limitError().message).toBe("ERR_RATE_V2");
  });
});
