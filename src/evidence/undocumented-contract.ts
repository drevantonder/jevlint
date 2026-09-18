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

type OpaqueLiteralCall = {
  filePath: string;
  call: string;
  line: number;
};

export type UndocumentedContractEvidence = {
  function: {
    name: string;
    filePath: string;
    source: string;
    parameterCount: number;
    parameters: string[];
    hasParameterTypes: boolean;
    hasReturnType: boolean;
  };
  documentation: {
    hasJsdoc: boolean;
    moduleJsdocCount: number;
    moduleExportCount: number;
  };
  thrownErrors: string[];
  callers: FunctionCaller[];
  crossModuleCallerCount: number;
  opaqueLiteralCalls: OpaqueLiteralCall[];
};

function hasJsdocBefore(source: string, start: number): boolean {
  const before = source.slice(Math.max(0, start - 2_000), start)
    .replace(/\s*export\s+(default\s+)?(async\s+)?$/, "");
  return /\/\*\*[\s\S]*?\*\/\s*$/.test(before);
}

function parameterSources(fn: FunctionNode, source: string): string[] {
  return fn.params.map((parameter) => source.slice(parameter.start, parameter.end));
}

function signatureHead(fn: FunctionNode, source: string): string {
  const body = fn.body;
  const end = body ? body.start : fn.end;
  return source.slice(fn.start, end);
}

function thrownErrorMessages(
  program: Program,
  fn: FunctionNode,
  source: string,
): string[] {
  const messages: string[] = [];
  let depth = 0;
  const isDirect = (node: FunctionNode): boolean => node.start === fn.start && node.end === fn.end;
  const enter = (node: FunctionNode): void => {
    if (isDirect(node)) depth = 1;
    else if (depth > 0) depth += 1;
  };
  const exit = (node: FunctionNode): void => {
    if (depth === 0) return;
    depth -= 1;
    if (isDirect(node)) depth = 0;
  };
  new Visitor({
    ArrowFunctionExpression: enter,
    "ArrowFunctionExpression:exit": exit,
    FunctionDeclaration: enter,
    "FunctionDeclaration:exit": exit,
    FunctionExpression: enter,
    "FunctionExpression:exit": exit,
    ThrowStatement(node) {
      if (depth === 1) messages.push(source.slice(node.argument.start, node.argument.end).slice(0, 200));
    },
  }).visit(program);
  return messages.slice(0, 10);
}

function moduleDocumentation(program: Program, source: string) {
  const jsdocCount = source.match(/\/\*\*/g)?.length ?? 0;
  let exportCount = 0;
  for (const statement of program.body) {
    if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") {
      exportCount += 1;
    }
  }
  return { jsdocCount, exportCount };
}

export function buildUndocumentedContractEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UndocumentedContractEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  if (!isFunctionExported(parsed.program, fn, name)) return undefined;

  const parameters = parameterSources(fn, owner.source);
  const head = signatureHead(fn, owner.source);
  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);
  const documentation = moduleDocumentation(parsed.program, owner.source);
  const opaqueLiteralCalls = callers
    .filter(({ arguments: callArguments }) =>
      callArguments.some((argument) => /^(true|false|undefined|null)$/.test(argument.trim()))
    )
    .map(({ filePath, call, line }): OpaqueLiteralCall => ({ filePath, call, line }))
    .slice(0, 10);

  return {
    function: {
      name,
      filePath: candidate.filePath,
      source: candidate.source,
      parameterCount: parameters.length,
      parameters: parameters.map((parameter) => parameter.slice(0, 120)),
      hasParameterTypes: parameters.some((parameter) => parameter.includes(":")),
      hasReturnType: /\)\s*:/.test(head),
    },
    documentation: {
      hasJsdoc: hasJsdocBefore(owner.source, candidate.start),
      moduleJsdocCount: documentation.jsdocCount,
      moduleExportCount: documentation.exportCount,
    },
    thrownErrors: thrownErrorMessages(parsed.program, fn, owner.source),
    callers,
    crossModuleCallerCount: callers.filter(({ filePath }) => filePath !== candidate.filePath).length,
    opaqueLiteralCalls,
  };
}