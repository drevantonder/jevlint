import { describe, expect, it, vi } from "vitest";
import { slugify } from "../src/slug.js";
import { cardPath } from "../src/cart.js";

vi.mock("../src/slug.js", () => ({
  slugify: vi.fn((title: string) => title.trim().toLowerCase().replaceAll(/\s+/g, "-")),
}));

describe("card path", () => {
  it("builds a path from the title", () => {
    vi.mocked(slugify).mockReturnValue("hello-world");
    expect(cardPath("Hello World")).toBe("/cards/hello-world");
  });
});
