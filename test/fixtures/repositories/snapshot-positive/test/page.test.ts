import { it, expect } from "vitest";
import { renderPage } from "../src/page.js";

it("renders the page", () => {
  expect(renderPage({ user: "ada" })).toMatchInlineSnapshot(`"<main><h1>hello ada</h1><nav><a href="/">home</a></nav></main>"`);
});
