import { describe, expect, it } from "vitest";
import { deduplicateDiagnostics } from "../src/deduplicate.js";
import type { Diagnostic } from "../src/types.js";

function diagnostic(ruleId: string, line: number, endLine = line): Diagnostic {
  return {
    filePath: "src/example.ts",
    line,
    column: 1,
    endLine,
    endColumn: 1,
    severity: "warning",
    ruleId,
    message: ruleId,
    probability: 0.9,
  };
}

describe("diagnostic deduplication", () => {
  it("keeps the more specific root cause for the same code", () => {
    const diagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-speculative-generality", 4, 12),
      diagnostic("jev/no-generic-magic", 4, 12),
    ]);

    expect(diagnostics.map(({ ruleId }) => ruleId)).toEqual(["jev/no-generic-magic"]);
  });

  it("prefers a state-model cause over generic configuration on the same type", () => {
    const diagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-disproportionate-configuration", 4, 12),
      diagnostic("jev/no-correlated-state-booleans", 4, 12),
    ]);

    expect(diagnostics.map(({ ruleId }) => ruleId)).toEqual([
      "jev/no-correlated-state-booleans",
    ]);
  });

  it("prefers constrained state modeling over generic configuration", () => {
    const diagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-disproportionate-configuration", 4, 12),
      diagnostic("jev/no-unconstrained-state-string", 4, 12),
    ]);

    expect(diagnostics.map(({ ruleId }) => ruleId)).toEqual([
      "jev/no-unconstrained-state-string",
    ]);
  });

  it("prefers an invalid state model over generic abstraction findings", () => {
    const diagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-needless-abstraction", 4, 12),
      diagnostic("jev/no-conditionally-valid-state", 4, 12),
    ]);

    expect(diagnostics.map(({ ruleId }) => ruleId)).toEqual([
      "jev/no-conditionally-valid-state",
    ]);
  });

  it("keeps independent findings in separate spans", () => {
    const diagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-pass-through-wrapper", 4, 6),
      diagnostic("jev/no-ad-hoc-branching", 20, 30),
    ]);

    expect(diagnostics).toHaveLength(2);
  });

  it("prefers a whole-change cause over a contained symptom", () => {
    const diagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-pass-through-wrapper", 5, 8),
      diagnostic("jev/no-complexity-displacement", 1, 20),
    ]);

    expect(diagnostics.map(({ ruleId }) => ruleId)).toEqual(["jev/no-complexity-displacement"]);
  });
});
