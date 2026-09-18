import { describe, expect, it } from "vitest";
import { createUser, getUser } from "../src/user.js";

describe("getUser", () => {
  it("getUser", () => {
    const user = getUser("u1");
    expect(user.id).toBe("u1");
  });

  it("createUser", () => {
    const user = createUser({ name: "ada", email: "ada@example.com" });
    expect(user.name).toBe("ada");
  });
});
