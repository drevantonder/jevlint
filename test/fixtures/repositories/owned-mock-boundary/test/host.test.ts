import { describe, expect, it, vi } from "vitest";

vi.mock("node:os", () => ({
  hostname: vi.fn(() => "test-host"),
}));

import { label } from "../src/host.js";

describe("host", () => {
  it("labels with the host name", () => {
    expect(label()).toBe("host:test-host");
  });
});
