import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type TruncatingNumericParseEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  parses: string[];
  usesRadixlessParseInt: boolean;
  hasNaNGuard: boolean;
  hasRangeCheck: boolean;
  hasExternalInput: boolean;
  siblingValidatedParse: boolean;
  callers: FunctionCaller[];
};

const EXTERNAL_INPUT = /\b(req|request|query|params|body|input|formData|searchParams|argv|event\.target)\b/;

export function buildTruncatingNumericParseEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): TruncatingNumericParseEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const parses: string[] = [];
  let usesRadixlessParseInt = false;

  const push = (node: { start: number; end: number }): void => {
    if (parses.length < 20) parses.push(owner.source.slice(node.start, node.end).slice(0, 240));
  };

  let functionDepth = 0;
  const isDirect = (node: FunctionNode): boolean => node.start === fn.start && node.end === fn.end;
  const enterFunction = (node: FunctionNode): void => {
    if (isDirect(node)) functionDepth = 1;
    else if (functionDepth > 0) functionDepth += 1;
  };
  const exitFunction = (node: FunctionNode): void => {
    if (functionDepth === 0) return;
    functionDepth -= 1;
    if (isDirect(node)) functionDepth = 0;
  };

  new Visitor({
    ArrowFunctionExpression: enterFunction,
    "ArrowFunctionExpression:exit": exitFunction,
    FunctionDeclaration: enterFunction,
    "FunctionDeclaration:exit": exitFunction,
    FunctionExpression: enterFunction,
    "FunctionExpression:exit": exitFunction,
    CallExpression(node) {
      if (functionDepth !== 1) return;
      const callee = node.callee.type === "ChainExpression" ? node.callee.expression : node.callee;
      if (callee.type !== "Identifier") return;
      if (callee.name === "parseInt") {
        push(node);
        if (node.arguments.length < 2) usesRadixlessParseInt = true;
      } else if (callee.name === "Number" || callee.name === "parseFloat") {
        push(node);
      }
    },
    UnaryExpression(node) {
      if (functionDepth !== 1) return;
      if (node.operator !== "+") return;
      push(node);
    },
    BinaryExpression(node) {
      if (functionDepth !== 1) return;
      if (node.operator !== "|") return;
      push(node);
    },
  }).visit(parsed.program);

  if (parses.length === 0) return undefined;

  const body = owner.source.slice(fn.start, fn.end);
  const hasNaNGuard = /Number\.isNaN|\bisNaN\b|Number\.isFinite|\bisFinite\b|Number\.isInteger/.test(body);
  const hasRangeCheck = /Math\.(min|max|clamp)|[<>=]\s*\d|\b(min|max|length|between)\b/i.test(body);
  const hasExternalInput = EXTERNAL_INPUT.test(body);

  let siblingValidatedParse = false;
  for (const file of projectFiles) {
    if (file.filePath === owner.filePath) continue;
    if (
      /parseInt\(.*,\s*10\)/.test(file.source)
      && /Number\.isNaN|\bisNaN\b|Number\.isFinite/.test(file.source)
    ) {
      siblingValidatedParse = true;
      break;
    }
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    parses,
    usesRadixlessParseInt,
    hasNaNGuard,
    hasRangeCheck,
    hasExternalInput,
    siblingValidatedParse,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
