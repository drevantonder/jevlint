import { describe, expect, it } from "vitest";
import { _state, increment } from "../src/internal/store.js";

describe("store", () => {
  it("bumps the internal counter", () => {
    increment();
    const snapshot = _state as any;
    expect(snapshot.count).toBe(1);
    expect((_state as any)._history ?? []).toEqual([]);
  });
});
