import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  nestedFunctionRanges,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";
import {
  applyComparisonBudget,
  lineStartOffsets,
  orderScopeFiles,
  projectOrderIndex,
  rankComparisons,
  resolvePairwiseBounds,
  sameOpcodeSequence,
  scopedCandidate,
  topLevelOpcodes,
} from "./pairwise-scope.js";

export type SimilarityTrigger = {
  opcodeOverlap: number;
  sameOpcodeSequence: boolean;
  sharedMemberNames: string[];
  sharedLiteralValues: string[];
};

export type LookalikeDivergence = {
  filePath: string;
  functionName: string;
  sourceExcerpt: string;
  candidateOnlyMembers: string[];
  matchOnlyMembers: string[];
  candidateOnlyLiterals: string[];
  matchOnlyLiterals: string[];
  sharedNameTokens: string[];
  distinctNameTokens: string[];
  sameModuleRole: boolean;
  candidateCallerFiles: string[];
  matchCallerFiles: string[];
  commonCallerFiles: string[];
  sharedImportSources: string[];
};

export type CoincidentalSimilarityEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  trigger: SimilarityTrigger;
  lookalikes: LookalikeDivergence[];
  callers: FunctionCaller[];
};

const GENERIC_MEMBERS = new Set([
  "map",
  "filter",
  "forEach",
  "reduce",
  "push",
  "pop",
  "slice",
  "length",
  "then",
  "catch",
]);

type Fingerprint = {
  opcodes: string[];
  memberNames: string[];
  literalValues: string[];
};

function literalValue(raw: string | null): string | undefined {
  if (raw === null || raw === "") return undefined;
  const first = raw[0];
  const last = raw.at(-1);
  if ((first === "\"" || first === "'") && last === first) return raw.slice(1, -1);
  return raw;
}

function fingerprintOf(
  program: Program,
  node: FunctionNode,
  candidate: Candidate,
): Fingerprint {
  const opcodes: string[] = [];
  const memberNames = new Set<string>();
  const literalValues = new Set<string>();
  const nested = nestedFunctionRanges(program, candidate);
  const own = (start: number, end: number): boolean =>
    start >= node.start && end <= node.end
    && !nested.some((range) => range.start <= start && range.end >= end);

  const body = node.body;
  if (body) {
    if (body.type === "BlockStatement") {
      for (const statement of body.body) opcodes.push(statement.type);
    } else {
      opcodes.push(`expression:${body.type}`);
    }
  }

  new Visitor({
    MemberExpression(member) {
      if (!own(member.start, member.end)) return;
      const property = member.property;
      if (!member.computed && property.type === "Identifier") {
        memberNames.add(property.name);
      } else if (member.computed && property.type === "Literal") {
        const value = literalValue(property.raw);
        if (value !== undefined) memberNames.add(value);
      }
    },
    Literal(literal) {
      if (!own(literal.start, literal.end)) return;
      const value = literalValue(literal.raw);
      if (value !== undefined && value !== "undefined") literalValues.add(value);
    },
  }).visit(program);

  return {
    opcodes,
    memberNames: [...memberNames].sort(),
    literalValues: [...literalValues].sort(),
  };
}

function intersect(left: string[], right: string[]): string[] {
  const set = new Set(right);
  return left.filter((item) => set.has(item));
}

function difference(left: string[], right: string[]): string[] {
  const set = new Set(right);
  return left.filter((item) => !set.has(item));
}

function opcodeOverlap(left: string[], right: string[]): number {
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

function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3);
}

function moduleRole(filePath: string): string {
  const parts = filePath.split("/");
  parts.pop();
  return parts.join("/") || ".";
}

export function buildCoincidentalSimilarityEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): CoincidentalSimilarityEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const fingerprint = fingerprintOf(parsed.program, fn, candidate);
  if (fingerprint.opcodes.length < 2) return undefined;

  const ownerImports = new Set(moduleImports(parsed.program).map(({ source }) => source));
  const candidateCallers = findFunctionCallers(owner.filePath, name, projectFiles);
  const candidateCallerFiles = [...new Set(candidateCallers.map(({ filePath }) => filePath))];
  const candidateTokens = nameTokens(name);

  const bounds = resolvePairwiseBounds();
  const related = new Set<string>();
  for (const imported of moduleImports(parsed.program)) {
    const resolved = resolveModule(owner.filePath, imported.source, projectFiles);
    if (resolved && resolved.filePath !== owner.filePath) related.add(resolved.filePath);
  }
  const scope = orderScopeFiles(owner.filePath, projectFiles, related, bounds.maxScopeFiles);
  const projectOrder = projectOrderIndex(projectFiles);

  type EnumeratedFunction = {
    file: ProjectFile;
    program: Program;
    node: FunctionNode;
    name: string;
    starts: number[];
    sequence: number;
  };
  const enumerated: EnumeratedFunction[] = [];
  for (const file of scope.files) {
    const other = parseCached(file.filePath, file.source);
    if (other.errors.some((error) => error.severity === "Error")) continue;
    const functions: FunctionNode[] = [];
    new Visitor({
      ArrowFunctionExpression: (node) => {
        functions.push(node);
      },
      FunctionDeclaration: (node) => {
        functions.push(node);
      },
      FunctionExpression: (node) => {
        functions.push(node);
      },
    }).visit(other.program);
    const starts = lineStartOffsets(file.source);
    let sequence = 0;
    for (const otherFn of functions) {
      if (file.filePath === owner.filePath && otherFn.start === fn.start && otherFn.end === fn.end) continue;
      const otherName = functionName(other.program, otherFn);
      if (!otherName) continue;
      if (topLevelOpcodes(otherFn).length < 2) continue;
      enumerated.push({ file, program: other.program, node: otherFn, name: otherName, starts, sequence });
      sequence += 1;
    }
  }

  const budget = applyComparisonBudget(
    // Divergent names are the signal here, so the cheap rank must not
    // reward shared vocabulary; opcode overlap alone orders the set.
    rankComparisons(fingerprint.opcodes, name, enumerated, 0),
    bounds.maxFullComparisons,
    bounds.prePass,
  );

  type PreliminaryLookalike = {
    file: ProjectFile;
    program: Program;
    node: FunctionNode;
    name: string;
    fingerprint: Fingerprint;
    preliminaryScore: number;
    fileOrder: number;
    sequence: number;
  };
  const ownerRole = moduleRole(owner.filePath);
  const preliminary: PreliminaryLookalike[] = [];
  budget.selected.forEach((ranked, index) => {
    const target = ranked.entry;
    const otherFingerprint = fingerprintOf(
      target.program,
      target.node,
      scopedCandidate(target.file, target.file.source, target.starts, target.node, `coincidental-similarity-${index}`),
    );
    const sharedMembers = intersect(fingerprint.memberNames, otherFingerprint.memberNames)
      .filter((member) => !GENERIC_MEMBERS.has(member));
    const sharedLiterals = intersect(fingerprint.literalValues, otherFingerprint.literalValues);
    const sequence = sameOpcodeSequence(fingerprint.opcodes, otherFingerprint.opcodes);
    const triggered = sharedLiterals.length >= 1 || sharedMembers.length >= 2 || sequence;
    if (!triggered) return;
    const otherTokens = nameTokens(target.name);
    const candidateOnlyMembers = difference(
      fingerprint.memberNames.filter((member) => !GENERIC_MEMBERS.has(member)),
      otherFingerprint.memberNames,
    );
    const matchOnlyMembers = difference(
      otherFingerprint.memberNames.filter((member) => !GENERIC_MEMBERS.has(member)),
      fingerprint.memberNames,
    );
    const distinctTokens = [...new Set([
      ...difference(candidateTokens, otherTokens),
      ...difference(otherTokens, candidateTokens),
    ])];
    preliminary.push({
      file: target.file,
      program: target.program,
      node: target.node,
      name: target.name,
      fingerprint: otherFingerprint,
      preliminaryScore: candidateOnlyMembers.length + matchOnlyMembers.length + distinctTokens.length,
      fileOrder: projectOrder.get(target.file.filePath) ?? projectFiles.length,
      sequence: target.sequence,
    });
  });

  if (preliminary.length === 0) return undefined;
  // Caller scans run only for the preliminary leaders. The preliminary
  // score already contains every ranking term except the common-caller
  // term, so whenever all qualifying comparisons fit the resolution
  // budget the final ranking is unchanged.
  preliminary.sort((left, right) =>
    right.preliminaryScore - left.preliminaryScore
    || left.fileOrder - right.fileOrder
    || left.sequence - right.sequence,
  );
  const leaders = preliminary.slice(0, bounds.maxCallerResolutions);
  const lookalikes: Array<{
    divergence: LookalikeDivergence;
    score: number;
    fingerprint: Fingerprint;
    fileOrder: number;
    sequence: number;
  }> = leaders
    .map((entry) => {
      const otherCallers = findFunctionCallers(entry.file.filePath, entry.name, projectFiles);
      const matchCallerFiles = [...new Set(otherCallers.map(({ filePath }) => filePath))];
      const otherTokens = nameTokens(entry.name);
      const sharedTokens = intersect(candidateTokens, otherTokens);
      const otherImports = moduleImports(entry.program).map(({ source }) => source);
      const candidateOnlyMembers = difference(
        fingerprint.memberNames.filter((member) => !GENERIC_MEMBERS.has(member)),
        entry.fingerprint.memberNames,
      ).slice(0, 20);
      const matchOnlyMembers = difference(
        entry.fingerprint.memberNames.filter((member) => !GENERIC_MEMBERS.has(member)),
        fingerprint.memberNames,
      ).slice(0, 20);
      const distinctTokens = [...new Set([
        ...difference(candidateTokens, otherTokens),
        ...difference(otherTokens, candidateTokens),
      ])].slice(0, 20);
      const commonCallerFiles = [...new Set(
        matchCallerFiles.filter((path) => candidateCallerFiles.includes(path)),
      )].slice(0, 10);
      const divergence: LookalikeDivergence = {
        filePath: entry.file.filePath,
        functionName: entry.name,
        sourceExcerpt: entry.file.source.slice(entry.node.start, entry.node.end).slice(0, 2_000),
        candidateOnlyMembers,
        matchOnlyMembers,
        candidateOnlyLiterals: difference(
          fingerprint.literalValues,
          entry.fingerprint.literalValues,
        ).slice(0, 20),
        matchOnlyLiterals: difference(
          entry.fingerprint.literalValues,
          fingerprint.literalValues,
        ).slice(0, 20),
        sharedNameTokens: sharedTokens,
        distinctNameTokens: distinctTokens,
        sameModuleRole: ownerRole === moduleRole(entry.file.filePath),
        candidateCallerFiles: candidateCallerFiles.slice(0, 10),
        matchCallerFiles: matchCallerFiles.slice(0, 10),
        commonCallerFiles,
        sharedImportSources: [...new Set(
          otherImports.filter((source) => ownerImports.has(source)),
        )].slice(0, 10),
      };
      return {
        divergence,
        fingerprint: entry.fingerprint,
        score: candidateOnlyMembers.length + matchOnlyMembers.length
          + distinctTokens.length - commonCallerFiles.length * 2,
        fileOrder: entry.fileOrder,
        sequence: entry.sequence,
      };
    });

  lookalikes.sort((left, right) =>
    right.score - left.score
    || left.fileOrder - right.fileOrder
    || left.sequence - right.sequence,
  );
  const top = lookalikes.slice(0, 3);

  const first = top[0];
  if (!first) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    trigger: {
      opcodeOverlap: opcodeOverlap(fingerprint.opcodes, first.fingerprint.opcodes),
      sameOpcodeSequence: sameOpcodeSequence(fingerprint.opcodes, first.fingerprint.opcodes),
      sharedMemberNames: intersect(fingerprint.memberNames, first.fingerprint.memberNames)
        .filter((member) => !GENERIC_MEMBERS.has(member)).slice(0, 20),
      sharedLiteralValues: intersect(fingerprint.literalValues, first.fingerprint.literalValues).slice(0, 20),
    },
    lookalikes: top.map(({ divergence }) => divergence),
    callers: candidateCallers,
  };
}
