import { parseSync, Visitor } from "oxc-parser";
import type { CallExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type TimeoutRaceCall = {
  call: string;
  line: number;
};

export type HandRolledPromiseTimeoutEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  timeoutRaces: TimeoutRaceCall[];
  clearsTimeout: boolean;
  signalThreaded: boolean;
  taskSignals: string[];
  callers: FunctionCaller[];
};

const RACE_PATTERN = /Promise\s*\.\s*race/;
const REJECT_PATTERN = /\breject\s*\(/;
const TIMEOUT_WORD_PATTERN = /\btimed?\s?out|\btimeout\b|TimeoutError|AbortError/i;
const SIGNAL_PATTERN = /AbortSignal|AbortController|\bsignal\b/;
const TASK_SIGNAL_PATTERN = /fetch\s*\(|signal\s*:|addEventListener/;
const PLATFORM_TIMEOUT_PATTERN = /AbortSignal\s*\.\s*timeout/;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function calleeName(call: CallExpression): string | undefined {
  if (call.callee.type === "Identifier") return call.callee.name;
  return undefined;
}

export function buildHandRolledPromiseTimeoutEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HandRolledPromiseTimeoutEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  // Already on the platform mechanism: nothing hand-rolled to score.
  if (PLATFORM_TIMEOUT_PATTERN.test(candidate.source)) return undefined;
  if (!RACE_PATTERN.test(candidate.source) && !REJECT_PATTERN.test(candidate.source)) {
    return undefined;
  }

  const timeoutRaces: TimeoutRaceCall[] = [];
  let clearsTimeout = false;
  new Visitor({
    CallExpression(call) {
      if (call.start < candidate.start || call.end > candidate.end) return;
      const callee = calleeName(call);
      if (callee === "setTimeout") {
        timeoutRaces.push({
          call: owner.source.slice(call.start, call.end).slice(0, 200),
          line: lineAt(owner.source, call.start),
        });
      }
      if (callee === "clearTimeout") clearsTimeout = true;
    },
  }).visit(parsed.program);
  if (timeoutRaces.length === 0) return undefined;

  const taskSignals = new Set<string>();
  const timeoutMatch = TIMEOUT_WORD_PATTERN.exec(candidate.source);
  if (timeoutMatch) taskSignals.add(timeoutMatch[0].slice(0, 40));
  const taskMatch = TASK_SIGNAL_PATTERN.exec(candidate.source);
  if (taskMatch) taskSignals.add(taskMatch[0].slice(0, 40));

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    timeoutRaces: timeoutRaces.slice(0, 10),
    clearsTimeout,
    signalThreaded: SIGNAL_PATTERN.test(candidate.source),
    taskSignals: [...taskSignals],
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
