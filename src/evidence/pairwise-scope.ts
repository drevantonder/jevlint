// Bounded comparison-set construction shared by the pairwise function-similarity
// rules (duplicated-logic, coincidental-similarity, paraphrased-sibling-logic).
//
// Cost model: each of those rules runs once per review candidate and, per
// candidate, re-enumerates every function in every context file and then runs
// one or more whole-program visitors per enumerated function plus one
// whole-project caller scan per surviving match. That is O(candidates x
// functions) parse/visitor work with a large constant. This module does not
// cache parses or fingerprints (a separate effort owns evidence memoization;
// anything here stacks with it). It only shrinks the SET of comparisons:
//
//   1. Owner-first ordering: the candidate's own module is always scanned
//      first, then modules related through imports, then everything else.
//      Same-module siblings carry the strongest duplication signal (the
//      same-module-only clone-and-tweak-sibling rule is precedent), so when a
//      budget binds, the comparisons most likely to matter survive.
//   2. Cheap structural pre-pass: top-level statement shape and name tokens
//      are readable directly off each enumerated function node with zero
//      visitors. Only the highest-scoring functions (plus every function
//      whose statement shape already matches the candidate exactly, since
//      that alone qualifies as a match) proceed to full fingerprinting.
//   3. Deferred caller resolution: whole-project caller scans run only for
//      matches that survive ranking, not for every qualifying comparison.
//   4. Single-pass line offsets: locating a function in its file is a binary
//      search over precomputed line starts instead of a rescan of the file
//      prefix per function.
//
// Exactness contract: whenever the enumerated comparison count fits inside
// the budgets, output is bit-identical to unbounded scanning. The budgets
// default far above every recorded fixture, so small inputs are unaffected;
// targeted tests pin both the identity below the budgets and the
// determinism above them.
import type { Candidate, ProjectFile } from "../types.js";
import type { FunctionNode } from "./repository.js";

export interface PairwiseBounds {
  /** Maximum context files scanned per candidate (owner module always included). */
  maxScopeFiles: number;
  /** Maximum functions fully fingerprinted per candidate. */
  maxFullComparisons: number;
  /** Maximum qualifying matches enriched with caller scans. */
  maxCallerResolutions: number;
  /** Rank by the cheap structural pre-pass before full fingerprinting. */
  prePass: boolean;
}

export const DEFAULT_PAIRWISE_BOUNDS: PairwiseBounds = {
  maxScopeFiles: 40,
  maxFullComparisons: 400,
  maxCallerResolutions: 12,
  prePass: true,
};

let activeScopeOverrides: PairwiseBounds | undefined;

export function resolvePairwiseBounds(): PairwiseBounds {
  return activeScopeOverrides ?? DEFAULT_PAIRWISE_BOUNDS;
}

/**
 * Fix the bounds for subsequent builder calls in this process (benchmarks
 * and tests). Pass `undefined` to restore defaults. Builders keep the
 * registry-mandated `(candidate, projectFiles)` signature; this setter is
 * the only override path, so review-time behavior is always defaults.
 */
export function setPairwiseScopeOverrides(overrides?: Partial<PairwiseBounds>): void {
  activeScopeOverrides = overrides === undefined ? undefined : { ...DEFAULT_PAIRWISE_BOUNDS, ...overrides };
}

/** Line-start offsets of a source file, computed in one pass. */
export function lineStartOffsets(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

/** 1-based source position, matching the historical char-scan behavior. */
export interface FilePosition {
  line: number;
  column: number;
}

/**
 * Position of an offset, matching the historical char-scan implementation
 * (line and column both 1-based; only "\n" advances lines).
 */
export function positionAt(source: string, starts: number[], offset: number): FilePosition {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 };
}

/** Build a candidate record for an enumerated function without rescanning the file. */
export function scopedCandidate(
  file: ProjectFile,
  source: string,
  starts: number[],
  node: FunctionNode,
  id: string,
): Candidate {
  const start = positionAt(source, starts, node.start);
  const end = positionAt(source, starts, node.end);
  return {
    id,
    kind: "function",
    filePath: file.filePath,
    source: source.slice(node.start, node.end),
    start: node.start,
    end: node.end,
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

/** Deterministically ordered scope files with a bound flag. */
export interface ScopeOrder {
  files: ProjectFile[];
  bounded: boolean;
}

/**
 * Order scope files deterministically: the owner module first, then related
 * modules (import neighbours) in project order, then everything else in
 * project order. Truncates to maxScopeFiles; the owner is always kept.
 */
export function orderScopeFiles(
  ownerPath: string,
  projectFiles: ProjectFile[],
  related: ReadonlySet<string> | undefined,
  maxScopeFiles: number,
): ScopeOrder {
  const owner = projectFiles.find((file) => file.filePath === ownerPath);
  const ordered: ProjectFile[] = [];
  if (owner) ordered.push(owner);
  const seen = new Set<string>(owner ? [ownerPath] : []);
  const pushInOrder = (paths: Iterable<string>): void => {
    for (const path of paths) {
      if (seen.has(path)) continue;
      const file = projectFiles.find((entry) => entry.filePath === path);
      if (!file) continue;
      seen.add(path);
      ordered.push(file);
    }
  };
  if (related) {
    pushInOrder(projectFiles.filter((file) => related.has(file.filePath)).map((file) => file.filePath));
  }
  pushInOrder(projectFiles.map((file) => file.filePath));
  if (ordered.length <= maxScopeFiles) return { files: ordered, bounded: false };
  const head = ordered.slice(0, maxScopeFiles);
  if (owner && !head.includes(owner)) head[head.length - 1] = owner;
  return { files: head, bounded: true };
}

/**
 * Top-level statement shape of a function body, read directly off the node
 * with no visitor. This is exactly the opcode list the body fingerprinters
 * derive from the body, so opcode-level gates evaluated here match.
 */
export function topLevelOpcodes(node: FunctionNode): string[] {
  const body = node.body;
  if (!body) return [];
  if (body.type === "BlockStatement") return body.body.map((statement) => statement.type);
  return [`expression:${body.type}`];
}

function opcodeOverlapCount(left: string[], right: string[]): number {
  const counts = new Map<string, number>();
  for (const opcode of right) counts.set(opcode, (counts.get(opcode) ?? 0) + 1);
  let shared = 0;
  for (const opcode of left) {
    const remaining = counts.get(opcode) ?? 0;
    if (remaining > 0) {
      shared += 1;
      counts.set(opcode, remaining - 1);
    }
  }
  return shared;
}

export function sameOpcodeSequence(left: string[], right: string[]): boolean {
  return left.length >= 3 && left.length === right.length && left.every((opcode, index) => opcode === right[index]);
}

function nameTokens(name: string): Set<string> {
  const tokens = new Set<string>();
  for (const part of name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/)) {
    const token = part.toLowerCase();
    if (token.length >= 3) tokens.add(token);
  }
  return tokens;
}

export interface RankedComparison<Context> {
  entry: Context;
  opcodes: string[];
  /** True when the free opcode shape alone already qualifies a match. */
  sequenceMatch: boolean;
  score: number;
}

/**
 * Score enumerated functions with visitor-free signals only. Score blends
 * top-level opcode overlap (weight 2, mirroring the literal weight in match
 * ranking) with name-token overlap. Never excludes sequenceMatch entries: an
 * identical statement sequence qualifies regardless of members/literals.
 */
export function rankComparisons<Context extends { node: FunctionNode; name: string }>(
  candidateOpcodes: string[],
  candidateName: string,
  entries: Context[],
  nameWeight = 1,
): Array<RankedComparison<Context>> {
  const candidateTokens = nameTokens(candidateName);
  return entries.map((entry) => {
    const opcodes = topLevelOpcodes(entry.node);
    const sequenceMatch = sameOpcodeSequence(candidateOpcodes, opcodes);
    const tokens = nameTokens(entry.name);
    let sharedTokens = 0;
    for (const token of tokens) {
      if (candidateTokens.has(token)) sharedTokens += 1;
    }
    return {
      entry,
      opcodes,
      sequenceMatch,
      score: opcodeOverlapCount(candidateOpcodes, opcodes) * 2 + sharedTokens * nameWeight,
    };
  });
}

/**
 * Position of a scope file in the original project order. Used only as a
 * deterministic tiebreaker so ranked output below the budgets reproduces
 * unbounded scan order exactly.
 */
export function projectOrderIndex(projectFiles: ProjectFile[]): Map<string, number> {
  const order = new Map<string, number>();
  projectFiles.forEach((file, index) => {
    if (!order.has(file.filePath)) order.set(file.filePath, index);
  });
  return order;
}
export interface ComparisonBudget<Context> {
  /** Entries selected for full fingerprinting, best first (sequence matches lead). */
  selected: Array<RankedComparison<Context>>;
  /** True when the budget bound the set (output may differ from unbounded). */
  bounded: boolean;
}

/**
 * Split ranked comparisons into the full-fingerprint set. When the
 * enumerated count fits the budget every entry is selected and downstream
 * output is identical to unbounded scanning. Above the budget, exact shape
 * matches lead and the remaining budget goes to the best cheap scores;
 * ties keep enumeration order, so selection is deterministic.
 */
export function applyComparisonBudget<Context>(
  ranked: Array<RankedComparison<Context>>,
  maxFullComparisons: number,
  prePass: boolean,
): ComparisonBudget<Context> {
  if (!prePass || ranked.length <= maxFullComparisons) {
    return { selected: ranked, bounded: false };
  }
  const sequenceEntries = ranked.filter((entry) => entry.sequenceMatch);
  const rest = ranked.filter((entry) => !entry.sequenceMatch);
  rest.sort((left, right) => right.score - left.score);
  const selected = [...sequenceEntries, ...rest].slice(0, maxFullComparisons);
  selected.sort((left, right) => {
    if (left.sequenceMatch !== right.sequenceMatch) return left.sequenceMatch ? -1 : 1;
    return right.score - left.score;
  });
  return { selected, bounded: true };
}

