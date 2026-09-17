import type { Diagnostic } from "./types.js";

const RULE_PRIORITY = new Map<string, number>([
  ["jev/no-complexity-displacement", 100],
  ["jev/no-correlated-state-booleans", 95],
  ["jev/no-disproportionate-configuration", 90],
  ["jev/no-avoidable-orchestration", 90],
  ["jev/no-ad-hoc-branching", 90],
  ["jev/no-pass-through-wrapper", 90],
  ["jev/no-needless-abstraction", 85],
  ["jev/no-generic-magic", 85],
  ["jev/no-speculative-generality", 70],
]);

function overlaps(left: Diagnostic, right: Diagnostic): boolean {
  return left.filePath === right.filePath
    && left.line <= right.endLine
    && right.line <= left.endLine;
}

function sameAccidentalComplexityRoot(left: Diagnostic, right: Diagnostic): boolean {
  return RULE_PRIORITY.has(left.ruleId)
    && RULE_PRIORITY.has(right.ruleId)
    && overlaps(left, right);
}

function rank(diagnostic: Diagnostic): number {
  return RULE_PRIORITY.get(diagnostic.ruleId) ?? 0;
}

export function deduplicateDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const prioritized = [...diagnostics].sort((left, right) =>
    rank(right) - rank(left) || right.probability - left.probability,
  );
  const kept: Diagnostic[] = [];
  for (const diagnostic of prioritized) {
    if (kept.some((existing) => sameAccidentalComplexityRoot(existing, diagnostic))) continue;
    kept.push(diagnostic);
  }
  return kept.sort((left, right) =>
    left.filePath.localeCompare(right.filePath)
    || left.line - right.line
    || left.column - right.column
    || left.ruleId.localeCompare(right.ruleId),
  );
}
