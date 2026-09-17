import { describe, expect, it } from "vitest";

const logs: string[] = [];

function job(name: string, delay: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      logs.push(name);
      resolve();
    }, delay);
  });
}

describe("scheduler", () => {
  it("runs jobs in submission order", async () => {
    job("first", 10);
    job("second", 30);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(logs[0]).toBe("first");
    expect(logs[1]).toBe("second");
  });
});
