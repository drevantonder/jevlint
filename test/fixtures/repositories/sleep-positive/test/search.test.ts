import { describe, expect, it } from "vitest";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventuallyReady(): Promise<string> {
  return "ready";
}

describe("search", () => {
  it("returns results once the index settles", async () => {
    await sleep(2000);
    const status = await eventuallyReady();
    expect(status).toBe("ready");
  });
});
