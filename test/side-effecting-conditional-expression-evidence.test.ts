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

const assignedValueCall = `export function resolveCacheDir(useCustom: boolean, input: { cache: { dir?: string } }) {
  const cacheDir = useCustom ? (input.cache.dir ?? defaultCacheDir()) : undefined;
  return cacheDir;
}
`;

const assignedAwaitedCall = `export async function lookupAnswer(unit: string | undefined) {
  const hit = unit === undefined ? undefined : await readCachedAnswer(unit);
  return hit;
}
`;

const returnedValueCall = `export function describeStatus(ok: boolean, detail: string) {
  return ok ? formatDetail(detail) : fallbackStatus();
}
`;

const discardedCalls = `export function trigger(ready: boolean) {
  ready ? initialize() : cleanup();
  return ready;
}
`;

const armMutation = `export function pick(cond: boolean) {
  let selected = "default";
  const value = cond ? (selected = computeSelection()) : selected;
  return value;
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

  it("abstains for an assigned ternary whose arm call computes the value", () => {
    const filePath = "src/cache.ts";
    expect(buildSideEffectingConditionalEvidence(
      candidateFor(assignedValueCall, filePath, "resolveCacheDir"),
      project(assignedValueCall, filePath),
    )).toBeUndefined();
  });

  it("abstains for an assigned ternary awaiting the selected value", () => {
    const filePath = "src/lookup.ts";
    expect(buildSideEffectingConditionalEvidence(
      candidateFor(assignedAwaitedCall, filePath, "lookupAnswer"),
      project(assignedAwaitedCall, filePath),
    )).toBeUndefined();
  });

  it("abstains for a returned ternary choosing between two calls", () => {
    const filePath = "src/status.ts";
    expect(buildSideEffectingConditionalEvidence(
      candidateFor(returnedValueCall, filePath, "describeStatus"),
      project(returnedValueCall, filePath),
    )).toBeUndefined();
  });

  it("records a discarded ternary that invokes effects as statements", () => {
    const filePath = "src/trigger.ts";
    const evidence = buildSideEffectingConditionalEvidence(
      candidateFor(discardedCalls, filePath, "trigger"),
      project(discardedCalls, filePath),
    );
    expect(evidence?.conditionals).toHaveLength(1);
    expect(evidence?.conditionals[0]).toMatchObject({ nestingDepth: 1 });
    expect(evidence?.conditionals.every(
      ({ consequentEffects, alternateEffects }) => consequentEffects.length > 0 || alternateEffects.length > 0,
    )).toBe(true);
  });

  it("records a flat ternary that mutates through an arm", () => {
    const filePath = "src/pick.ts";
    const evidence = buildSideEffectingConditionalEvidence(
      candidateFor(armMutation, filePath, "pick"),
      project(armMutation, filePath),
    );
    expect(evidence?.conditionals).toHaveLength(1);
    expect(evidence?.conditionals[0]?.consequentEffects.join(" ")).toContain("selected =");
  });

  it("abstains for non-function candidates", () => {
    const filePath = "src/routing.ts";
    const candidate = { ...candidateFor(nested, filePath, "route"), kind: "change" as const };
    expect(buildSideEffectingConditionalEvidence(candidate, project(nested, filePath))).toBeUndefined();
  });
});
