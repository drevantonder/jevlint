import { describe, expect, it, vi } from "vitest";

vi.mock("../src/api/client", () => ({
  fetchUser: vi.fn().mockResolvedValue({ name: "Ada" }),
}));

import { fetchUser } from "../src/api/client";

describe("client", () => {
  it("returns the user", async () => {
    const user = await fetchUser("1");
    expect(user).toEqual({ name: "Ada" });
  });
});
