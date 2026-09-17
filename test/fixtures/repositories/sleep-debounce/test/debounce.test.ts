import { describe, expect, it } from "vitest";

function debounce(waitMs: number, work: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(work, waitMs);
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("debounce", () => {
  it("fires once after the debounce duration elapses", async () => {
    let calls = 0;
    const run = debounce(100, () => {
      calls += 1;
    });
    run();
    await delay(150);
    expect(calls).toBe(1);
  });
});
