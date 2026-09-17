import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";

const extractedRules = [
  ["jev/no-mysterious-name", "function"],
  ["jev/no-narrating-comment", "comment"],
  ["jev/no-foreign-mutation", "function"],
  ["jev/no-temporal-call-coupling", "function"],
  ["jev/no-shotgun-change", "change"],
  ["jev/no-undocumented-contract", "function"],
  ["jev/no-accidental-serialization", "function"],
  ["jev/no-discarded-transformation", "function"],
  ["jev/no-load-bearing-async", "function"],
  ["jev/no-untrusted-sink-input", "function"],
  ["jev/no-unreleased-subscription", "function"],
  ["jev/no-speculative-generality", "function"],
  ["jev/no-ad-hoc-branching", "function"],
  ["jev/no-feature-envy", "function"],
  ["jev/no-duplicated-logic", "function"],
  ["jev/no-type-code-dispatch", "function"],
  ["jev/no-mode-flag-parameter", "function"],
  ["jev/no-message-chain", "function"],
  ["jev/no-mixed-abstraction-levels", "function"],
  ["jev/no-unbounded-wait", "function"],
  ["jev/no-detached-async-work", "function"],
  ["jev/no-shared-mutable-module-state", "abstraction"],
  ["jev/no-type-checker-escape", "function"],
  ["jev/no-unawaited-iteration-work", "function"],
  ["jev/no-asymmetric-normalization", "function"],
  ["jev/no-unguarded-nullable-dereference", "function"],
  ["jev/no-falsy-absent-conflation", "function"],
  ["jev/no-unanchored-domain-check", "function"],
  ["jev/no-contract-signature-drift", "function"],
  ["jev/no-unwieldy-signature", "function"],
  ["jev/no-inappropriate-intimacy", "function"],
  ["jev/no-anemic-type", "abstraction"],
  ["jev/no-temporary-field", "abstraction"],
  ["jev/no-sensitive-data-in-log", "function"],
  ["jev/no-unsafe-redirect-target", "function"],
  ["jev/no-overbroad-origin-trust", "function"],
  ["jev/no-path-traversal-join", "function"],
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
