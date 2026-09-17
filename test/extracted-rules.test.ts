import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";

const extractedRules = [
  ["jev/no-mysterious-name", "function"],
  ["jev/no-speculative-generality", "function"],
  ["jev/no-ad-hoc-branching", "function"],
  ["jev/no-feature-envy", "function"],
  ["jev/no-unvalidated-boundary-shape", "function"],
  ["jev/no-stale-binding-use", "function"],
  ["jev/no-pre-gate-side-effect", "function"],
  ["jev/no-inverted-authorization-predicate", "function"],
  ["jev/no-hardcoded-config-shadow", "function"],
  ["jev/no-sibling-identifier-swap", "function"],
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
