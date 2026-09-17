import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type DatePartRead = {
  method: string;
  line: number;
};

export type DateAssembly = {
  padStartCalls: string[];
  joinCalls: string[];
  separatorLiterals: string[];
};

export type HandRolledDateFormatEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  dateParts: DatePartRead[];
  assembly: DateAssembly;
  usesIntlDateTimeFormat: boolean;
  intlDateShelf: string[];
  pinnedOutputSignals: string[];
  callers: FunctionCaller[];
};

const DATE_PART_METHODS = new Set([
  "getFullYear",
  "getMonth",
  "getDate",
  "getDay",
  "getHours",
  "getMinutes",
  "getSeconds",
  "getMilliseconds",
  "getTime",
  "getTimezoneOffset",
  "getUTCFullYear",
  "getUTCMonth",
  "getUTCDate",
  "getUTCHours",
  "getUTCMinutes",
]);

const SEPARATOR_PATTERN = /(['"`])([-/. :])\1/g;
const PINNED_PATTERN = /snapshot|toMatchSnapshot|toEqual\(|toStrictEqual\(|toBe\(|YYYY|DD\b|wire|serializ|contract|round-?trip/i;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function intlDateShelf(projectFiles: ProjectFile[], ownerPath: string): string[] {
  const result: string[] = [];
  for (const file of projectFiles) {
    if (file.filePath === ownerPath) continue;
    if (file.source.includes("Intl.DateTimeFormat")) {
      result.push(file.filePath);
      if (result.length >= 8) break;
    }
  }
  return result;
}

export function buildHandRolledDateFormatEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HandRolledDateFormatEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const dateParts: DatePartRead[] = [];
  const padStartCalls: string[] = [];
  const joinCalls: string[] = [];

  new Visitor({
    MemberExpression(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      if (node.property.type !== "Identifier") return;
      if (!DATE_PART_METHODS.has(node.property.name)) return;
      dateParts.push({
        method: node.property.name,
        line: lineAt(owner.source, node.start),
      });
    },
    CallExpression(call) {
      if (call.start < candidate.start || call.end > candidate.end) return;
      if (!belongsDirectlyToFunction(call, nested)) return;
      const callee = owner.source.slice(call.callee.start, call.callee.end);
      if (callee.endsWith(".padStart") || callee === "padStart") {
        padStartCalls.push(owner.source.slice(call.start, call.end).slice(0, 200));
      }
      if (callee.endsWith(".join") || callee === "join") {
        joinCalls.push(owner.source.slice(call.start, call.end).slice(0, 200));
      }
    },
  }).visit(parsed.program);

  if (dateParts.length < 2) return undefined;
  const separatorLiterals = [...candidate.source.matchAll(SEPARATOR_PATTERN)]
    .map((match) => match[2] ?? "")
    .filter((separator, index, all) => separator !== "" && all.indexOf(separator) === index);
  if (padStartCalls.length === 0 && separatorLiterals.length === 0 && joinCalls.length === 0) {
    return undefined;
  }

  const pinnedOutputSignals: string[] = [];
  const candidatePin = PINNED_PATTERN.exec(candidate.source);
  if (candidatePin) pinnedOutputSignals.push(candidatePin[0].slice(0, 80));
  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);
  for (const caller of callers) {
    const match = PINNED_PATTERN.exec(caller.call);
    if (match) pinnedOutputSignals.push(match[0].slice(0, 80));
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    dateParts: dateParts.slice(0, 12),
    assembly: {
      padStartCalls: padStartCalls.slice(0, 8),
      joinCalls: joinCalls.slice(0, 8),
      separatorLiterals,
    },
    usesIntlDateTimeFormat: candidate.source.includes("Intl.DateTimeFormat"),
    intlDateShelf: intlDateShelf(projectFiles, candidate.filePath),
    pinnedOutputSignals: pinnedOutputSignals.slice(0, 8),
    callers,
  };
}
