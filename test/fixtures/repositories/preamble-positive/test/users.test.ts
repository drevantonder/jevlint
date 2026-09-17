import { it, expect } from "vitest";

export function makeUser(name: string): { name: string; org: string; token: string } {
  return { name, org: "acme", token: "token-123" };
}

it("greets the user", () => {
  const user = { name: "ann", org: "acme", token: "token-123" };
  const label = `${user.org}:${user.name}`;
  expect(label).toBe("acme:ann");
});

it("signs the user", () => {
  const user = { name: "bob", org: "acme", token: "token-123" };
  const label = `${user.org}:${user.name}`;
  expect(label).toBe("acme:bob");
});

it("renews the user through the factory", () => {
  const user = makeUser("cid");
  expect(user.token).toBe("token-123");
});
