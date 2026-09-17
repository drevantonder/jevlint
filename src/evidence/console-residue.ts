import { parseSync, Visitor } from "oxc-parser";
import type { Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type ConsoleCall = {
  method: string;
  expression: string;
  line: number;
  firstArgument: string | null;
};

export type ConsoleResidueEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    testFile: boolean;
  };
  consoleCalls: ConsoleCall[];
  debuggerStatements: number[];
  loggerImports: string[];
  debugComments: string[];
  callers: FunctionCaller[];
};

const RESIDUE_METHODS = new Set(["log", "debug", "info", "trace", "dir", "table"]);

const LOGGER_SOURCES = ["winston", "pino", "bunyan", "loglevel", "signale", "roarr", "debug"];

const TEST_PATH_PATTERN = /(^|\/)(__tests__|__mocks__|test|tests|spec|e2e)(\/|$|\.)|\.(test|spec)\.[cm]?[jt]sx?$/;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function consoleMethod(callee: Expression): string | undefined {
  const unwrapped = callee.type === "ChainExpression" ? callee.expression : callee;
  if (unwrapped.type !== "MemberExpression" || unwrapped.computed) return undefined;
  if (unwrapped.object.type !== "Identifier" || unwrapped.object.name !== "console") return undefined;
  if (unwrapped.property.type !== "Identifier") return undefined;
  return RESIDUE_METHODS.has(unwrapped.property.name) ? unwrapped.property.name : undefined;
}

export function buildConsoleResidueEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ConsoleResidueEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  if (TEST_PATH_PATTERN.test(owner.filePath)) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const insideNested = (start: number, end: number): boolean =>
    nested.some((range) => range.start <= start && range.end >= end);

  const consoleCalls: ConsoleCall[] = [];
  const debuggerStatements: number[] = [];

  new Visitor({
    CallExpression(call) {
      if (call.start < candidate.start || call.end > candidate.end) return;
      if (insideNested(call.start, call.end)) return;
      const method = consoleMethod(call.callee);
      if (!method) return;
      const first = call.arguments[0];
      consoleCalls.push({
        method,
        expression: owner.source.slice(call.start, call.end),
        line: lineAt(owner.source, call.start),
        firstArgument: first && first.type !== "SpreadElement"
          ? owner.source.slice(first.start, first.end).slice(0, 200)
          : null,
      });
    },
    DebuggerStatement(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (insideNested(node.start, node.end)) return;
      debuggerStatements.push(lineAt(owner.source, node.start));
    },
  }).visit(parsed.program);

  if (consoleCalls.length === 0 && debuggerStatements.length === 0) return undefined;

  const imports = moduleImports(parsed.program);
  const loggerImports = imports
    .filter(({ source }) => LOGGER_SOURCES.some((logger) => source === logger || source.startsWith(`${logger}/`)))
    .map(({ source }) => source);

  const debugComments = parsed.comments
    .filter((comment) =>
      comment.start >= candidate.start
      && comment.end <= candidate.end
      && /console\.(log|debug|info|trace|dir|table)|debugger/.test(comment.value)
    )
    .map((comment) => owner.source.slice(comment.start, comment.end).slice(0, 200));

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
      testFile: false,
    },
    consoleCalls,
    debuggerStatements,
    loggerImports,
    debugComments,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
