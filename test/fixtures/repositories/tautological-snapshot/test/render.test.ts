import { describe, expect, it } from "vitest";
import { renderBadge } from "../src/render";

describe("render", () => {
  it("renders the badge", () => {
    expect(renderBadge("new")).toMatchSnapshot();
  });
});
