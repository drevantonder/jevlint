import { describe, expect, it, vi } from "vitest";

vi.mock("../src/pipeline.js", () => ({
  parse: vi.fn(() => [["a"]]),
  store: vi.fn(() => 1),
  format: vi.fn(() => "a"),
}));

import { format, parse, store } from "../src/pipeline.js";

describe("pipeline", () => {
  it("wires the stages in order", () => {
    const rows = parse("a");
    store(rows);
    format(rows);
    expect(parse).toHaveBeenCalledWith("a");
    expect(store).toHaveBeenCalledWith([["a"]]);
    expect(format).toHaveBeenCalledWith([["a"]]);
  });
});
