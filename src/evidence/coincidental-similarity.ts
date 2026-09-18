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
    id: `coincidental-similarity-${index}`,
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

function sameOpcodeSequence(left: string[], right: string[]): boolean {
  return left.length >= 3 && left.length === right.length && left.every((opcode, index) => opcode === right[index]);
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

  const lookalikes: Array<{ divergence: LookalikeDivergence; score: number; fingerprint: Fingerprint }> = [];
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
      const sequence = sameOpcodeSequence(fingerprint.opcodes, otherFingerprint.opcodes);
      const triggered = sharedLiterals.length >= 1 || sharedMembers.length >= 2 || sequence;
      if (!triggered) continue;
      const otherCallers = findFunctionCallers(file.filePath, otherName, projectFiles);
      const matchCallerFiles = [...new Set(otherCallers.map(({ filePath }) => filePath))];
      const otherTokens = nameTokens(otherName);
      const sharedTokens = intersect(candidateTokens, otherTokens);
      const ownerRole = moduleRole(owner.filePath);
      const otherImports = moduleImports(other.program).map(({ source }) => source);
      const divergence: LookalikeDivergence = {
        filePath: file.filePath,
        functionName: otherName,
        sourceExcerpt: file.source.slice(otherFn.start, otherFn.end).slice(0, 2_000),
        candidateOnlyMembers: difference(
          fingerprint.memberNames.filter((member) => !GENERIC_MEMBERS.has(member)),
          otherFingerprint.memberNames,
        ).slice(0, 20),
        matchOnlyMembers: difference(
          otherFingerprint.memberNames.filter((member) => !GENERIC_MEMBERS.has(member)),
          fingerprint.memberNames,
        ).slice(0, 20),
        candidateOnlyLiterals: difference(
          fingerprint.literalValues,
          otherFingerprint.literalValues,
        ).slice(0, 20),
        matchOnlyLiterals: difference(
          otherFingerprint.literalValues,
          fingerprint.literalValues,
        ).slice(0, 20),
        sharedNameTokens: sharedTokens,
        distinctNameTokens: [...new Set([
          ...difference(candidateTokens, otherTokens),
          ...difference(otherTokens, candidateTokens),
        ])].slice(0, 20),
        sameModuleRole: ownerRole === moduleRole(file.filePath),
        candidateCallerFiles: candidateCallerFiles.slice(0, 10),
        matchCallerFiles: matchCallerFiles.slice(0, 10),
        commonCallerFiles: [...new Set(
          matchCallerFiles.filter((path) => candidateCallerFiles.includes(path)),
        )].slice(0, 10),
        sharedImportSources: [...new Set(
          otherImports.filter((source) => ownerImports.has(source)),
        )].slice(0, 10),
      };
      lookalikes.push({
        divergence,
        fingerprint: otherFingerprint,
        score: divergence.candidateOnlyMembers.length + divergence.matchOnlyMembers.length
          + divergence.distinctNameTokens.length - divergence.commonCallerFiles.length * 2,
      });
    }
  }

  if (lookalikes.length === 0) return undefined;
  lookalikes.sort((left, right) => right.score - left.score);
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
