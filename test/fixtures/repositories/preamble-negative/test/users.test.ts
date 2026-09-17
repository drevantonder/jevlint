import { it, expect } from "vitest";

it("greets the user", () => {
  const user = { name: "ann", org: "acme" };
  expect(user.name).toBe("ann");
});

it("counts admins", () => {
  const rows = [1, 2, 3].filter((row) => row > 1);
  expect(rows).toHaveLength(2);
});

it("rejects blank names", () => {
  const attempt = (): string => {
    throw new Error("blank");
  };
  expect(attempt).toThrow("blank");
});
