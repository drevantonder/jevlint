import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type CloneSiblingFunction = {
  name: string;
  params: string[];
  statementCount: number;
  sourceExcerpt: string;
};

export type CloneSimilarity = {
  tokenJaccard: number;
  sharedTokens: number;
  candidateTokens: number;
  siblingTokens: number;
  sharedOpcodes: number;
  candidateOnlyLiterals: string[];
  siblingOnlyLiterals: string[];
  paramDelta: number;
};

export type CloneAndTweakSiblingEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    params: string[];
  };
  sibling: CloneSiblingFunction;
  similarity: CloneSimilarity;
  functionCallers: FunctionCaller[];
  siblingCallers: FunctionCaller[];
};

const WORD_PATTERN = /[A-Za-z_$][\w$]*/g;

function tokensOf(source: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of source.matchAll(WORD_PATTERN)) {
    const token = match[0].toLowerCase();
    if (token.length >= 2) tokens.add(token);
  }
  return tokens;
}

function literalText(raw: string | null): string | undefined {
  if (raw === null || raw === "") return undefined;
  const first = raw[0];
  const last = raw.at(-1);
  if ((first === "\"" || first === "'") && last === first) return raw.slice(1, -1);
  return raw;
}

function literalsOf(program: Program, node: FunctionNode): Set<string> {
  const values = new Set<string>();
  new Visitor({
    Literal(literal) {
      if (literal.start < node.start || literal.end > node.end) return;
      const value = literalText(literal.raw);
      if (value !== undefined && value !== "undefined") values.add(value);
    },
  }).visit(program);
  return values;
}

function paramNames(node: FunctionNode): string[] {
  const names: string[] = [];
  for (const parameter of node.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    if (value.type === "Identifier") names.push(value.name);
    else if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
      names.push(value.left.name);
    } else if (value.type === "RestElement" && value.argument.type === "Identifier") {
      names.push(`...${value.argument.name}`);
    }
  }
  return names;
}

function opcodesOf(node: FunctionNode): string[] {
  if (!node.body) return [];
  if (node.body.type !== "BlockStatement") return [`expression:${node.body.type}`];
  return node.body.body.map((statement) => statement.type);
}

function siblingFunctions(program: Program, candidate: Candidate): FunctionNode[] {
  const result: FunctionNode[] = [];
  const add = (node: FunctionNode): void => {
    if (node.start === candidate.start && node.end === candidate.end) return;
    if (node.start >= candidate.start && node.end <= candidate.end) return;
    if (candidate.start >= node.start && candidate.end <= node.end) return;
    result.push(node);
  };
  new Visitor({
    ArrowFunctionExpression: add,
    FunctionDeclaration: add,
    FunctionExpression: add,
  }).visit(program);
  return result;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return shared / (left.size + right.size - shared);
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

export function buildCloneAndTweakSiblingEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): CloneAndTweakSiblingEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const candidateTokens = tokensOf(owner.source.slice(fn.start, fn.end));
  const candidateLiterals = literalsOf(parsed.program, fn);
  const candidateOpcodes = opcodesOf(fn);
  if (candidateOpcodes.length < 2) return undefined;

  let best: { node: FunctionNode; name: string; score: number } | undefined;
  for (const sibling of siblingFunctions(parsed.program, candidate)) {
    const siblingName = functionName(parsed.program, sibling);
    if (!siblingName) continue;
    const score = jaccard(candidateTokens, tokensOf(owner.source.slice(sibling.start, sibling.end)));
    if (!best || score > best.score) best = { node: sibling, name: siblingName, score };
  }
  if (!best || best.score < 0.5) return undefined;

  const siblingTokens = tokensOf(owner.source.slice(best.node.start, best.node.end));
  const siblingLiterals = literalsOf(parsed.program, best.node);
  const siblingOpcodes = opcodesOf(best.node);
  const candidateParams = paramNames(fn);
  const siblingParams = paramNames(best.node);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
      params: candidateParams,
    },
    sibling: {
      name: best.name,
      params: siblingParams,
      statementCount: siblingOpcodes.length,
      sourceExcerpt: owner.source.slice(best.node.start, best.node.end).slice(0, 2_000),
    },
    similarity: {
      tokenJaccard: Math.round(best.score * 1000) / 1000,
      sharedTokens: [...candidateTokens].filter((token) => siblingTokens.has(token)).length,
      candidateTokens: candidateTokens.size,
      siblingTokens: siblingTokens.size,
      sharedOpcodes: opcodeOverlap(candidateOpcodes, siblingOpcodes),
      candidateOnlyLiterals: [...candidateLiterals].filter((value) => !siblingLiterals.has(value)).slice(0, 10),
      siblingOnlyLiterals: [...siblingLiterals].filter((value) => !candidateLiterals.has(value)).slice(0, 10),
      paramDelta: Math.abs(candidateParams.length - siblingParams.length),
    },
    functionCallers: findFunctionCallers(owner.filePath, name, projectFiles),
    siblingCallers: findFunctionCallers(owner.filePath, best.name, projectFiles),
  };
}
