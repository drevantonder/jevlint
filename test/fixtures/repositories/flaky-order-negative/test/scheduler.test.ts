import { describe, expect, it } from "vitest";

function job(name: string, delay: number): Promise<string> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(name), delay);
  });
}

describe("scheduler", () => {
  it("collects every job result", async () => {
    const first = job("first", 30);
    const second = job("second", 10);
    const results = await Promise.all([first, second]);
    expect([...results].sort()).toEqual(["first", "second"]);
  });
});
