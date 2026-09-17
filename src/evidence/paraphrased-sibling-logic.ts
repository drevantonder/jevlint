import { parseSync, Visitor } from "oxc-parser";
import type { Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type SiblingSignature = {
  parameterCount: number;
  parameterTypes: string[];
  returnType: string | null;
};

export type ParaphrasedSiblingMatch = {
  filePath: string;
  functionName: string;
  signature: SiblingSignature;
  dissimilarity: number;
  sharedLiteralValues: string[];
  sharedMemberNames: string[];
  commonCallerFiles: string[];
  sourceExcerpt: string;
};

export type ParaphrasedSiblingLogicEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  signature: SiblingSignature;
  matches: ParaphrasedSiblingMatch[];
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

function parameterType(parameterSource: string): string {
  const match = /:\s*([^=]+?)\s*$/.exec(parameterSource.trim());
  return (match?.[1] ?? "").trim().toLowerCase().slice(0, 80);
}

function signatureOf(fn: FunctionNode, source: string): SiblingSignature {
  const parameterTypes = fn.params.map((parameter) =>
    parameterType(source.slice(parameter.start, parameter.end))
  );
  let returnType: string | null = null;
  if (fn.body) {
    const between = source.slice(fn.params[fn.params.length - 1]?.end ?? fn.start, fn.body.start);
    const match = /:\s*([^=]+?)\s*$/.exec(between.trim());
    if (match?.[1]) returnType = match[1].trim().toLowerCase().slice(0, 80);
  }
  return { parameterCount: fn.params.length, parameterTypes, returnType };
}

function signaturesEquivalent(left: SiblingSignature, right: SiblingSignature): boolean {
  if (left.parameterCount !== right.parameterCount || left.parameterCount === 0) return false;
  if (left.returnType !== right.returnType) return false;
  return left.parameterTypes.every((type, index) => type === (right.parameterTypes[index] ?? null));
}

const NON_IMPLEMENTATION_TOKENS = new Set([
  "export",
  "import",
  "from",
  "as",
  "type",
  "interface",
  "string",
  "number",
  "boolean",
  "void",
  "unknown",
  "any",
  "return",
  "const",
  "let",
  "function",
]);

function identifierTokens(source: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of source.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    const token = match[0].toLowerCase();
    if (NON_IMPLEMENTATION_TOKENS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

function dissimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : 1 - shared / union;
}

function literalValues(program: Program, fn: FunctionNode): Set<string> {
  const values = new Set<string>();
  new Visitor({
    Literal(literal) {
      if (literal.start < fn.start || literal.end > fn.end) return;
      const raw = literal.raw;
      if (raw === null || raw === "") return;
      values.add(raw.length > 40 ? raw.slice(0, 40) : raw);
    },
  }).visit(program);
  return values;
}

function memberNames(program: Program, fn: FunctionNode): Set<string> {
  const names = new Set<string>();
  new Visitor({
    MemberExpression(member) {
      if (member.start < fn.start || member.end > fn.end) return;
      if (!member.computed && member.property.type === "Identifier") {
        names.add(member.property.name);
      }
    },
  }).visit(program);
  return names;
}

function relatedPaths(ownerPath: string, program: Program, projectFiles: ProjectFile[]): Set<string> {
  const related = new Set<string>([ownerPath]);
  for (const imported of moduleImports(program)) {
    const resolved = resolveModule(ownerPath, imported.source, projectFiles);
    if (resolved) related.add(resolved.filePath);
  }
  for (const file of projectFiles) {
    if (related.has(file.filePath)) continue;
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    for (const imported of moduleImports(parsed.program)) {
      if (resolveModule(file.filePath, imported.source, projectFiles)?.filePath === ownerPath) {
        related.add(file.filePath);
      }
    }
  }
  return related;
}

export function buildParaphrasedSiblingLogicEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ParaphrasedSiblingLogicEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const signature = signatureOf(fn, owner.source);
  if (signature.parameterCount === 0) return undefined;
  const candidateTokens = identifierTokens(candidate.source);
  const candidateLiterals = literalValues(parsed.program, fn);
  const candidateMembers = memberNames(parsed.program, fn);
  const related = relatedPaths(owner.filePath, parsed.program, projectFiles);
  const candidateCallers = findFunctionCallers(owner.filePath, name, projectFiles);
  const callerFiles = new Set(candidateCallers.map(({ filePath }) => filePath));

  const matches: ParaphrasedSiblingMatch[] = [];
  for (const file of projectFiles) {
    if (!related.has(file.filePath)) continue;
    const other = parseSync(file.filePath, file.source, { range: true });
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
      if (file.filePath === owner.filePath && otherFn.start === fn.start && otherFn.end === fn.end) {
        continue;
      }
      const otherName = functionName(other.program, otherFn);
      if (!otherName || otherName === name) continue;
      const otherSignature = signatureOf(otherFn, file.source);
      if (!signaturesEquivalent(signature, otherSignature)) continue;
      const otherSource = file.source.slice(otherFn.start, otherFn.end);
      const distance = dissimilarity(candidateTokens, identifierTokens(otherSource));
      if (distance < 0.5) continue;
      const otherLiterals = literalValues(other.program, otherFn);
      const sharedLiterals = [...candidateLiterals].filter((value) => otherLiterals.has(value));
      if (sharedLiterals.length > 0) continue;
      const otherMembers = memberNames(other.program, otherFn);
      const sharedMembers = [...candidateMembers].filter((member) =>
        otherMembers.has(member) && !GENERIC_MEMBERS.has(member)
      );
      if (sharedMembers.length >= 2) continue;
      const siblingCallers = findFunctionCallers(file.filePath, otherName, projectFiles);
      matches.push({
        filePath: file.filePath,
        functionName: otherName,
        signature: otherSignature,
        dissimilarity: Math.round(distance * 100) / 100,
        sharedLiteralValues: sharedLiterals.slice(0, 10),
        sharedMemberNames: sharedMembers.slice(0, 10),
        commonCallerFiles: [...new Set(
          siblingCallers.map(({ filePath }) => filePath).filter((path) => callerFiles.has(path)),
        )].slice(0, 10),
        sourceExcerpt: otherSource.slice(0, 2_000),
      });
    }
  }

  if (matches.length === 0) return undefined;
  matches.sort((left, right) => right.dissimilarity - left.dissimilarity);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    signature,
    matches: matches.slice(0, 5),
    callers: candidateCallers,
  };
}
