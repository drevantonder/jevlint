import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";

const extractedRules = [
  ["jev/no-mysterious-name", "function"],
  ["jev/no-speculative-generality", "function"],
  ["jev/no-ad-hoc-branching", "function"],
  ["jev/no-feature-envy", "function"],
  ["jev/no-duplicated-logic", "function"],
  ["jev/no-type-code-dispatch", "function"],
  ["jev/no-mode-flag-parameter", "function"],
  ["jev/no-message-chain", "function"],
  ["jev/no-mixed-abstraction-levels", "function"],
] as const;

describe("extracted review rules", () => {
  it.each(extractedRules)("ships %s as a %s judgment", (ruleId, scope) => {
    expect(defaultConfig.rules[ruleId]).toMatchObject({
      scope,
      message: expect.any(String),
    });
    expect(defaultConfig.rules[ruleId]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[ruleId]).not.toHaveProperty("severity");
  });
});
