import { describe, expect, it, vi } from "vitest";
import { loadTotal } from "../src/report.js";

vi.mock("../src/network.js", () => ({
  fetchJson: vi.fn(async () => ["a"]),
}));

describe("report", () => {
  it("counts the fetched lines", async () => {
    expect(await loadTotal()).toBe(1);
  });
});
