import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type RandomCall = {
  call: string;
  line: number;
  inTokenAssembly: boolean;
};

export type CredentialSink = {
  kind: "assignment" | "return" | "call";
  detail: string;
  line: number;
};

export type PredictableTokenEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  randomCalls: RandomCall[];
  tokenAssembly: {
    present: boolean;
    signals: string[];
  };
  secureAlternativeInScope: boolean;
  credentialSinks: CredentialSink[];
  callers: FunctionCaller[];
};

const TOKEN_ASSEMBLY_PATTERN = /toString\s*\(\s*36|slice|substring|substr|join\s*\(|padStart|padEnd/i;
const SECURE_ALTERNATIVE_PATTERN = /getRandomValues|randomUUID|crypto\.subtle|randomBytes|require\(["']crypto["']\)|from ["']node:crypto["']/;
const CREDENTIAL_BINDING_PATTERN = /token|session|secret|password|reset|auth|otp|nonce|api[_-]?key|client[_-]?secret/i;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function isMathRandomCall(call: CallExpression): boolean {
  return call.callee.type === "MemberExpression"
    && call.callee.object.type === "Identifier"
    && call.callee.object.name === "Math"
    && call.callee.property.type === "Identifier"
    && call.callee.property.name === "random";
}

function statementText(
  program: Program,
  fn: FunctionNode,
  source: string,
  offset: number,
): string | undefined {
  let found: string | undefined;
  const nested = nestedFunctionRanges(program, fn);
  new Visitor({
    ExpressionStatement(node) {
      if (found !== undefined) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      if (node.start <= offset && node.end >= offset) {
        found = source.slice(node.start, node.end);
      }
    },
    ReturnStatement(node) {
      if (found !== undefined) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      if (node.start <= offset && node.end >= offset) {
        found = source.slice(node.start, node.end);
      }
    },
    VariableDeclaration(node) {
      if (found !== undefined) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      if (node.start <= offset && node.end >= offset) {
        found = source.slice(node.start, node.end);
      }
    },
  }).visit(program);
  return found;
}

function randomDerivedNames(program: Program, fn: FunctionNode, source: string): Set<string> {
  const names = new Set<string>();
  const nested = nestedFunctionRanges(program, fn);
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || !node.init) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      if (source.slice(node.init.start, node.init.end).includes("Math.random")) {
        names.add(node.id.name);
      }
    },
  }).visit(program);
  return names;
}

function referencesName(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(source);
}

export function buildPredictableTokenEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): PredictableTokenEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const randomOffsets: { start: number; end: number }[] = [];
  new Visitor({
    CallExpression(call) {
      if (!isMathRandomCall(call)) return;
      if (call.start < candidate.start || call.end > candidate.end) return;
      if (!belongsDirectlyToFunction(call, nested)) return;
      randomOffsets.push({ start: call.start, end: call.end });
    },
  }).visit(parsed.program);
  if (randomOffsets.length === 0) return undefined;

  const signals = new Set<string>();
  const randomCalls = randomOffsets.map(({ start, end }): RandomCall => {
    const statement = statementText(parsed.program, fn, owner.source, start);
    const inAssembly = statement !== undefined && TOKEN_ASSEMBLY_PATTERN.test(statement);
    if (inAssembly) {
      const match = TOKEN_ASSEMBLY_PATTERN.exec(statement ?? "");
      if (match) signals.add(match[0].toLowerCase());
    }
    return {
      call: owner.source.slice(start, end),
      line: lineAt(owner.source, start),
      inTokenAssembly: inAssembly,
    };
  });

  const derived = randomDerivedNames(parsed.program, fn, owner.source);
  const sinks: CredentialSink[] = [];
  new Visitor({
    AssignmentExpression(node) {
      if (!belongsDirectlyToFunction(node, nested)) return;
      if (node.left.type !== "Identifier" && node.left.type !== "MemberExpression") return;
      const target = owner.source.slice(node.left.start, node.left.end);
      if (!CREDENTIAL_BINDING_PATTERN.test(target)) return;
      const value = owner.source.slice(node.right.start, node.right.end);
      if (![...derived].some((derivedName) => referencesName(value, derivedName))) return;
      sinks.push({ kind: "assignment", detail: owner.source.slice(node.start, node.end).slice(0, 200), line: lineAt(owner.source, node.start) });
    },
    ReturnStatement(node) {
      if (!node.argument || !belongsDirectlyToFunction(node, nested)) return;
      const value = owner.source.slice(node.argument.start, node.argument.end);
      if (![...derived].some((derivedName) => referencesName(value, derivedName))) return;
      sinks.push({ kind: "return", detail: value.slice(0, 200), line: lineAt(owner.source, node.start) });
    },
    CallExpression(call) {
      if (isMathRandomCall(call) || !belongsDirectlyToFunction(call, nested)) return;
      const callText = owner.source.slice(call.start, call.end);
      if (![...derived].some((derivedName) => referencesName(callText, derivedName))) return;
      sinks.push({ kind: "call", detail: callText.slice(0, 200), line: lineAt(owner.source, call.start) });
    },
  }).visit(parsed.program);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    randomCalls,
    tokenAssembly: { present: signals.size > 0, signals: [...signals] },
    secureAlternativeInScope: SECURE_ALTERNATIVE_PATTERN.test(owner.source),
    credentialSinks: sinks.slice(0, 10),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
