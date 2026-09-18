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
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

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

function positionOf(source: string, offset: number) {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function candidateOf(file: ProjectFile, node: FunctionNode, index: number): Candidate {
  const start = positionOf(file.source, node.start);
  const end = positionOf(file.source, node.end);
  return {
    id: `duplicated-logic-${index}`,
    kind: "function",
    filePath: file.filePath,
    source: file.source.slice(node.start, node.end),
    start: node.start,
    end: node.end,
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
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

function sameOpcodeSequence(left: string[], right: string[]): boolean {
  return left.length >= 3 && left.length === right.length && left.every((opcode, index) => opcode === right[index]);
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

  const matches: DuplicatedLogicMatch[] = [];
  let scanned = 0;
  for (const file of projectFiles) {
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
    for (const otherFn of functions) {
      if (file.filePath === owner.filePath && otherFn.start === fn.start && otherFn.end === fn.end) continue;
      const otherName = functionName(other.program, otherFn);
      if (!otherName) continue;
      scanned += 1;
      const otherFingerprint = fingerprintOf(other.program, otherFn, candidateOf(file, otherFn, scanned));
      if (otherFingerprint.opcodes.length < 2) continue;
      const sharedMembers = intersect(fingerprint.memberNames, otherFingerprint.memberNames)
        .filter((member) => !GENERIC_MEMBERS.has(member));
      const sharedLiterals = intersect(fingerprint.literalValues, otherFingerprint.literalValues);
      const qualifies = sharedLiterals.length >= 1
        || sharedMembers.length >= 2
        || sameOpcodeSequence(fingerprint.opcodes, otherFingerprint.opcodes);
      if (!qualifies) continue;
      const otherImports = moduleImports(other.program).map(({ source }) => source);
      const sharedImports = otherImports.filter((source) => ownerImports.has(source));
      const resolved = findFunctionCallers(file.filePath, otherName, projectFiles).map(({ filePath }) => filePath);
      matches.push({
        filePath: file.filePath,
        functionName: otherName,
        sourceExcerpt: file.source.slice(otherFn.start, otherFn.end).slice(0, 2_000),
        sharedOpcodes: opcodeOverlap(fingerprint.opcodes, otherFingerprint.opcodes),
        sharedMemberNames: sharedMembers.slice(0, 20),
        sharedLiteralValues: sharedLiterals.slice(0, 20),
        sharedImportSources: [...new Set(sharedImports)].slice(0, 10),
        commonCallerFiles: [...new Set(resolved.filter((path) => callerFiles.has(path)))].slice(0, 10),
      });
    }
  }

  if (matches.length === 0) return undefined;
  matches.sort((left, right) =>
    (right.sharedLiteralValues.length * 2 + right.sharedMemberNames.length + right.sharedOpcodes)
    - (left.sharedLiteralValues.length * 2 + left.sharedMemberNames.length + left.sharedOpcodes),
  );

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    fingerprint,
    matches: matches.slice(0, 5),
    callers: candidateCallers,
  };
}
