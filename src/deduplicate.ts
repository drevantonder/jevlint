import type { Diagnostic } from "./types.js";

const ACCIDENTAL_COMPLEXITY_PRIORITY = new Map<string, number>([
  ["jev/no-complexity-displacement", 100],
  ["jev/no-domain-policy-in-adapter", 96],
  ["jev/no-transport-coupled-domain", 95],
  ["jev/no-persistence-model-leak", 95],
  ["jev/no-interchangeable-domain-primitives", 90],
  ["jev/no-disproportionate-configuration", 90],
  ["jev/no-avoidable-orchestration", 90],
  ["jev/no-ad-hoc-branching", 90],
  ["jev/no-pass-through-wrapper", 90],
  ["jev/no-needless-abstraction", 85],
  ["jev/no-generic-magic", 85],
  ["jev/no-scattered-policy", 80],
  ["jev/no-speculative-generality", 70],
  ["jev/no-mixed-responsibilities", 60],
  ["jev/no-data-clump", 55],
]);

const STATE_MODEL_PRIORITY = new Map<string, number>([
  ["jev/no-conditionally-valid-state", 98],
  ["jev/no-correlated-state-booleans", 95],
  ["jev/no-unconstrained-state-string", 95],
]);

const EXPLICIT_EFFECTS_PRIORITY = new Map<string, number>([
  ["jev/no-implicit-atomicity", 99],
  ["jev/no-hidden-initialization-order", 98],
  ["jev/no-hidden-runtime-input", 95],
]);

const FAILURE_INTEGRITY_PRIORITY = new Map<string, number>([
  ["jev/no-unsafe-retry", 100],
  ["jev/no-hidden-partial-failure", 95],
  ["jev/no-lossy-error-translation", 90],
  ["jev/no-swallowed-error", 80],
]);

const INPUT_MUTATION_PRIORITY = new Map<string, number>([
  ["jev/no-hidden-input-mutation", 90],
]);

const API_SIDE_EFFECT_PRIORITY = new Map<string, number>([
  ["jev/no-query-side-effect", 95],
  ["jev/no-hidden-io", 85],
]);

const API_RETURN_PRIORITY = new Map<string, number>([
  ["jev/no-lossy-sentinel-return", 90],
]);

const RULE_FAMILIES = [
  ACCIDENTAL_COMPLEXITY_PRIORITY,
  STATE_MODEL_PRIORITY,
  EXPLICIT_EFFECTS_PRIORITY,
  FAILURE_INTEGRITY_PRIORITY,
  INPUT_MUTATION_PRIORITY,
  API_SIDE_EFFECT_PRIORITY,
  API_RETURN_PRIORITY,
];

function overlaps(left: Diagnostic, right: Diagnostic): boolean {
  return left.filePath === right.filePath
    && left.line <= right.endLine
    && right.line <= left.endLine;
}

function sameRuleFamilyRoot(left: Diagnostic, right: Diagnostic): boolean {
  return RULE_FAMILIES.some((family) => family.has(left.ruleId) && family.has(right.ruleId))
    && overlaps(left, right);
}

function rank(diagnostic: Diagnostic): number {
  return Math.max(...RULE_FAMILIES.map((family) => family.get(diagnostic.ruleId) ?? 0));
}

export function deduplicateDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const prioritized = [...diagnostics].sort((left, right) =>
    rank(right) - rank(left) || right.probability - left.probability,
  );
  const kept: Diagnostic[] = [];
  for (const diagnostic of prioritized) {
    if (kept.some((existing) => sameRuleFamilyRoot(existing, diagnostic))) continue;
    kept.push(diagnostic);
  }
  return kept.sort((left, right) =>
    left.filePath.localeCompare(right.filePath)
    || left.line - right.line
    || left.column - right.column
    || left.ruleId.localeCompare(right.ruleId),
  );
}
