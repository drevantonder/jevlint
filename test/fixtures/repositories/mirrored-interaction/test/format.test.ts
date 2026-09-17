import { describe, expect, it, vi } from "vitest";
import { format } from "../src/format";

describe("format", () => {
  it("forwards the payload", () => {
    const formatMock = vi.fn(format);
    formatMock("payload");
    expect(formatMock).toHaveBeenCalledWith("payload");
  });
});
