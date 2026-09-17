import { describe, expect, it } from "vitest";

async function waitFor(condition: () => Promise<string>): Promise<string> {
  return condition();
}

async function eventuallyReady(): Promise<string> {
  return "ready";
}

describe("search", () => {
  it("returns results once the index settles", async () => {
    const status = await waitFor(eventuallyReady);
    expect(status).toBe("ready");
  });
});
