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

  it("keeps state-model findings separate from accidental-complexity findings", () => {
    const diagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-disproportionate-configuration", 4, 12),
      diagnostic("jev/no-correlated-state-booleans", 4, 12),
    ]);

    expect(diagnostics.map(({ ruleId }) => ruleId)).toEqual([
      "jev/no-correlated-state-booleans",
      "jev/no-disproportionate-configuration",
    ]);
  });

  it("keeps closed-state findings separate from generic configuration", () => {
    const diagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-disproportionate-configuration", 4, 12),
      diagnostic("jev/no-unconstrained-state-string", 4, 12),
    ]);

    expect(diagnostics.map(({ ruleId }) => ruleId)).toEqual([
      "jev/no-disproportionate-configuration",
      "jev/no-unconstrained-state-string",
    ]);
  });

  it("prefers the strongest state-model cause for the same type", () => {
    const diagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-correlated-state-booleans", 4, 12),
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

  it("keeps a specific branch smell instead of the broad mixed-responsibility symptom", () => {
    const diagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-mixed-responsibilities", 4, 20),
      diagnostic("jev/no-ad-hoc-branching", 4, 20),
    ]);

    expect(diagnostics.map(({ ruleId }) => ruleId)).toEqual(["jev/no-ad-hoc-branching"]);
  });

  it("prefers a hidden command over its generic I/O symptom", () => {
    const diagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-hidden-io", 5, 12),
      diagnostic("jev/no-query-side-effect", 5, 12),
    ]);

    expect(diagnostics.map(({ ruleId }) => ruleId)).toEqual(["jev/no-query-side-effect"]);
  });

  it("keeps independent principle families on the same function", () => {
    const diagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-hidden-input-mutation", 5, 12),
      diagnostic("jev/no-query-side-effect", 5, 12),
      diagnostic("jev/no-generic-magic", 5, 12),
    ]);

    expect(diagnostics.map(({ ruleId }) => ruleId)).toEqual([
      "jev/no-generic-magic",
      "jev/no-hidden-input-mutation",
      "jev/no-query-side-effect",
    ]);
  });
});
