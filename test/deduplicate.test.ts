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

  it("keeps a specific branch smell instead of broad cohesion symptoms", () => {
    const diagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-data-clump", 4, 20),
      diagnostic("jev/no-mixed-responsibilities", 4, 20),
      diagnostic("jev/no-scattered-policy", 4, 20),
      diagnostic("jev/no-ad-hoc-branching", 4, 20),
    ]);

    expect(diagnostics.map(({ ruleId }) => ruleId)).toEqual(["jev/no-ad-hoc-branching"]);
  });

  it("prefers a domain boundary cause over branching symptoms", () => {
    const diagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-ad-hoc-branching", 5, 12),
      diagnostic("jev/no-transport-coupled-domain", 5, 12),
    ]);

    expect(diagnostics.map(({ ruleId }) => ruleId)).toEqual([
      "jev/no-transport-coupled-domain",
    ]);
  });

  it("prefers a persistence leak over a pass-through symptom", () => {
    const diagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-pass-through-wrapper", 5, 8),
      diagnostic("jev/no-persistence-model-leak", 5, 8),
    ]);

    expect(diagnostics.map(({ ruleId }) => ruleId)).toEqual([
      "jev/no-persistence-model-leak",
    ]);
  });

  it("prefers erased domain meaning over speculative generality", () => {
    const diagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-speculative-generality", 5, 10),
      diagnostic("jev/no-interchangeable-domain-primitives", 5, 10),
    ]);

    expect(diagnostics.map(({ ruleId }) => ruleId)).toEqual([
      "jev/no-interchangeable-domain-primitives",
    ]);
  });

  it("prefers misplaced domain policy over branching symptoms", () => {
    const diagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-ad-hoc-branching", 5, 12),
      diagnostic("jev/no-domain-policy-in-adapter", 5, 12),
    ]);

    expect(diagnostics.map(({ ruleId }) => ruleId)).toEqual([
      "jev/no-domain-policy-in-adapter",
    ]);
  });

  it("suppresses explicit-effect symptoms without suppressing unrelated rules", () => {
    const atomicityDiagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-hidden-initialization-order", 4, 12),
      diagnostic("jev/no-implicit-atomicity", 4, 12),
    ]);
    const initializationDiagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-hidden-runtime-input", 20, 28),
      diagnostic("jev/no-hidden-initialization-order", 20, 28),
    ]);
    const unrelatedDiagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-avoidable-orchestration", 40, 48),
      diagnostic("jev/no-implicit-atomicity", 40, 48),
    ]);

    expect(atomicityDiagnostics.map(({ ruleId }) => ruleId)).toEqual([
      "jev/no-implicit-atomicity",
    ]);
    expect(initializationDiagnostics.map(({ ruleId }) => ruleId)).toEqual([
      "jev/no-hidden-initialization-order",
    ]);
    expect(unrelatedDiagnostics.map(({ ruleId }) => ruleId)).toEqual([
      "jev/no-avoidable-orchestration",
      "jev/no-implicit-atomicity",
    ]);
  });

  it("prefers a specific failure-integrity cause over a generic symptom", () => {
    const diagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-swallowed-error", 4, 12),
      diagnostic("jev/no-lossy-error-translation", 4, 12),
    ]);

    expect(diagnostics.map(({ ruleId }) => ruleId)).toEqual([
      "jev/no-lossy-error-translation",
    ]);
  });

  it("keeps findings from different principle families", () => {
    const diagnostics = deduplicateDiagnostics([
      diagnostic("jev/no-ad-hoc-branching", 4, 12),
      diagnostic("jev/no-swallowed-error", 4, 12),
    ]);

    expect(diagnostics.map(({ ruleId }) => ruleId)).toEqual([
      "jev/no-ad-hoc-branching",
      "jev/no-swallowed-error",
    ]);
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
