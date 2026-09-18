import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, nestedFunctionRanges } from "./function-scope.js";
import { manifestFacts } from "./manifest-facts.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type RetryLoopSignal = {
  signal: string;
  excerpt: string;
};

export type HandRolledRetryLoopEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  ownedRetryDep: string;
  siblingImporters: string[];
  lockfilePresent: boolean;
  signals: RetryLoopSignal[];
  hasJitter: boolean;
  callers: FunctionCaller[];
};

const RETRY_DEPS = ["p-retry", "async-retry", "retry", "cockatiel"];

const DELAY_PATTERN = /\bsetTimeout\b|\bsleep\s*\(|\bdelay\s*\(/;
const ATTEMPT_PATTERN = /\battempts?\s*(?:\+\+|\+=|\b<|\b>|=)|\bretries\b|\bmaxRetries\b/;
const JITTER_PATTERN = /\bMath\s*\.\s*random\s*\(/;
const CATCH_PATTERN = /\bcatch\s*\(/;

export function buildHandRolledRetryLoopEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HandRolledRetryLoopEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const facts = manifestFacts(projectFiles, candidate.filePath, RETRY_DEPS);
  if (!facts.matchedDep) return undefined;
  if (facts.candidateImportsDep) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  let hasLoop = false;
  let hasTry = false;
  new Visitor({
    ForStatement(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      hasLoop = true;
    },
    WhileStatement(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      hasLoop = true;
    },
    TryStatement(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      hasTry = true;
    },
  }).visit(parsed.program);
  if (!hasLoop || !hasTry) return undefined;

  const signals: RetryLoopSignal[] = [{ signal: "retry-loop", excerpt: name.slice(0, 200) }];
  const delay = DELAY_PATTERN.exec(candidate.source);
  if (!delay) return undefined;
  signals.push({ signal: "delay-between-attempts", excerpt: delay[0].slice(0, 200) });
  const attempts = ATTEMPT_PATTERN.exec(candidate.source);
  if (attempts) signals.push({ signal: "attempt-counting", excerpt: attempts[0].slice(0, 200) });
  const catchClause = CATCH_PATTERN.exec(candidate.source);
  if (catchClause) signals.push({ signal: "catch-and-continue", excerpt: catchClause[0].slice(0, 200) });

  const hasJitter = JITTER_PATTERN.test(candidate.source);
  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    ownedRetryDep: facts.matchedDep,
    siblingImporters: facts.siblingImporters,
    lockfilePresent: facts.lockfilePresent,
    signals,
    hasJitter,
    callers,
  };
}
