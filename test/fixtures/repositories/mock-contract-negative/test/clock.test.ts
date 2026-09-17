import { describe, expect, it, vi } from "vitest";

vi.mock("../src/clock", () => ({
  now: vi.fn().mockReturnValue(1_700_000_000_000),
}));

import { now } from "../src/clock";

describe("clock", () => {
  it("formats the mocked instant", () => {
    expect(new Date(now()).getFullYear()).toBe(2023);
  });
});
