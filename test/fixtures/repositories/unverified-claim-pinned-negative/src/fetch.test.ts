import { describe, expect, it } from "vitest";
import { fetchWithRetry } from "./fetch.js";

describe("fetchWithRetry", () => {
  it("retries transient failures with backoff before succeeding", async () => {
    let calls = 0;
    const result = await fetchWithRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });
});
