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

export type BodyFingerprint = {
  opcodes: string[];
  memberNames: string[];
  literalValues: string[];
};

export type DuplicatedLogicMatch = {
  filePath: string;
  functionName: string;
  sourceExcerpt: string;
  sharedOpcodes: number;
  sharedMemberNames: string[];
  sharedLiteralValues: string[];
  sharedImportSources: string[];
  commonCallerFiles: string[];
};

export type DuplicatedLogicEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  fingerprint: BodyFingerprint;
  matches: DuplicatedLogicMatch[];
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
): BodyFingerprint {
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

export function buildDuplicatedLogicEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DuplicatedLogicEvidence | undefined {
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
  const callerFiles = new Set(candidateCallers.map(({ filePath }) => filePath));

  const bounds = resolvePairwiseBounds();
  // Import neighbours first: same-module and directly connected comparisons
  // carry the strongest signal, so they survive when the scope budget binds.
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
      // Opcode shape is free (read off the node); the length gate below
      // matches the fingerprinter's own minimum exactly.
      if (topLevelOpcodes(otherFn).length < 2) continue;
      enumerated.push({ file, program: other.program, node: otherFn, name: otherName, starts, sequence });
      sequence += 1;
    }
  }

  const budget = applyComparisonBudget(
    rankComparisons(fingerprint.opcodes, name, enumerated),
    bounds.maxFullComparisons,
    bounds.prePass,
  );

  type PreliminaryMatch = Omit<DuplicatedLogicMatch, "sharedImportSources" | "commonCallerFiles"> & {
    other: Program;
    fileOrder: number;
    sequence: number;
  };
  const preliminary: PreliminaryMatch[] = [];
  budget.selected.forEach((ranked, index) => {
    const target = ranked.entry;
    const otherFingerprint = fingerprintOf(
      target.program,
      target.node,
      scopedCandidate(target.file, target.file.source, target.starts, target.node, `duplicated-logic-${index}`),
    );
    const sharedMembers = intersect(fingerprint.memberNames, otherFingerprint.memberNames)
      .filter((member) => !GENERIC_MEMBERS.has(member));
    const sharedLiterals = intersect(fingerprint.literalValues, otherFingerprint.literalValues);
    const qualifies = sharedLiterals.length >= 1
      || sharedMembers.length >= 2
      || sameOpcodeSequence(fingerprint.opcodes, otherFingerprint.opcodes);
    if (!qualifies) return;
    preliminary.push({
      filePath: target.file.filePath,
      functionName: target.name,
      sourceExcerpt: target.file.source.slice(target.node.start, target.node.end).slice(0, 2_000),
      sharedOpcodes: opcodeOverlap(fingerprint.opcodes, otherFingerprint.opcodes),
      sharedMemberNames: sharedMembers.slice(0, 20),
      sharedLiteralValues: sharedLiterals.slice(0, 20),
      other: target.program,
      fileOrder: projectOrder.get(target.file.filePath) ?? projectFiles.length,
      sequence: target.sequence,
    });
  });

  if (preliminary.length === 0) return undefined;
  preliminary.sort((left, right) =>
    (right.sharedLiteralValues.length * 2 + right.sharedMemberNames.length + right.sharedOpcodes)
    - (left.sharedLiteralValues.length * 2 + left.sharedMemberNames.length + left.sharedOpcodes)
    || left.fileOrder - right.fileOrder
    || left.sequence - right.sequence,
  );

  // Caller scans run only for ranked survivors. Ranking uses no caller
  // data, so deferring them changes nothing but cost.
  const matches: DuplicatedLogicMatch[] = preliminary.slice(0, 5).map((entry) => {
    const otherImports = moduleImports(entry.other).map(({ source }) => source);
    const sharedImports = otherImports.filter((source) => ownerImports.has(source));
    const resolved = findFunctionCallers(entry.filePath, entry.functionName, projectFiles)
      .map(({ filePath }) => filePath);
    return {
      filePath: entry.filePath,
      functionName: entry.functionName,
      sourceExcerpt: entry.sourceExcerpt,
      sharedOpcodes: entry.sharedOpcodes,
      sharedMemberNames: entry.sharedMemberNames,
      sharedLiteralValues: entry.sharedLiteralValues,
      sharedImportSources: [...new Set(sharedImports)].slice(0, 10),
      commonCallerFiles: [...new Set(resolved.filter((path) => callerFiles.has(path)))].slice(0, 10),
    };
  });

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    fingerprint,
    matches,
    callers: candidateCallers,
  };
}
