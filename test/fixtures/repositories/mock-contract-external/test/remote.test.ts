import { describe, expect, it, vi } from "vitest";

vi.mock("undici", () => ({
  request: vi.fn().mockResolvedValue({ statusCode: 200 }),
}));

import { request } from "undici";

describe("remote", () => {
  it("reads the status", async () => {
    const response = await request("https://example.com");
    expect(response.statusCode).toBe(200);
  });
});
