import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildSideEffectingConditionalEvidence } from "../src/evidence/side-effecting-conditional-expression.js";
import type { ProjectFile } from "../src/types.js";

const nested = `export function route(mode: string) {
  return mode === "fast" ? startFast() : mode === "slow" ? startSlow() : stop();
}
`;

const effectfulLogical = `export function boot(ready: boolean) {
  ready && initialize();
  return status();
}
`;

const flatPure = `export function label(ok: boolean) {
  return ok ? "yes" : "no";
}
`;

function project(source: string, filePath = "src/routing.ts"): ProjectFile[] {
  return [{ filePath, source }];
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("side effecting conditional expression evidence", () => {
  it("records nested effectful ternaries with arm effects", () => {
    const filePath = "src/routing.ts";
    const evidence = buildSideEffectingConditionalEvidence(candidateFor(nested, filePath, "route"), project(nested, filePath));

    expect(evidence).toMatchObject({
      function: { name: "route", exported: true },
    });
    expect(evidence?.conditionals.map(({ nestingDepth }) => nestingDepth).sort()).toEqual([1, 2]);
    expect(evidence?.conditionals.every(
      ({ consequentEffects, alternateEffects }) => consequentEffects.length > 0 || alternateEffects.length > 0,
    )).toBe(true);
  });

  it("records statement-position logical chains that invoke effects", () => {
    const filePath = "src/boot.ts";
    const evidence = buildSideEffectingConditionalEvidence(
      candidateFor(effectfulLogical, filePath, "boot"),
      project(effectfulLogical, filePath),
    );

    expect(evidence?.logicalStatements).toHaveLength(1);
    expect(evidence?.logicalStatements[0]).toMatchObject({ operator: "&&" });
  });

  it("abstains for a flat ternary selecting pure values", () => {
    const filePath = "src/label.ts";
    expect(buildSideEffectingConditionalEvidence(candidateFor(flatPure, filePath, "label"), project(flatPure, filePath))).toBeUndefined();
  });

  it("abstains for non-function candidates", () => {
    const filePath = "src/routing.ts";
    const candidate = { ...candidateFor(nested, filePath, "route"), kind: "change" as const };
    expect(buildSideEffectingConditionalEvidence(candidate, project(nested, filePath))).toBeUndefined();
  });
});
