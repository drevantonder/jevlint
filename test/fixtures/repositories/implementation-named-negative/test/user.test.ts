import { describe, expect, it } from "vitest";
import { createUser, getUser } from "../src/user.js";

describe("user lookup", () => {
  it("returns the stored user for a known id", () => {
    const user = getUser("u1");
    expect(user.id).toBe("u1");
  });

  it("rejects creation with a missing email", () => {
    let error: unknown;
    try {
      createUser({ name: "ada" });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toBe("email is required");
  });

  const suffix = "lookup";
  it(`returns the stored user ${suffix}`, () => {
    const user = getUser("u2");
    expect(user.id).toBe("u2");
  });
});
