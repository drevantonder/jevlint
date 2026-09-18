import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import { manifestFacts } from "./manifest-facts.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type ConcurrencyLimitSignal = {
  signal: string;
  excerpt: string;
};

export type HandRolledConcurrencyLimitEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  ownedLimiterDep: string;
  siblingImporters: string[];
  lockfilePresent: boolean;
  signals: ConcurrencyLimitSignal[];
  callers: FunctionCaller[];
};

const LIMITER_DEPS = ["p-limit", "bottleneck", "p-queue"];

const ACTIVE_COUNTER_PATTERN = /\bactive\w*\s*(?:\+\+|--|\+=|-=)|\bactive\w*\s*(?:<|>|<=|>=)\s*\w+|\binFlight\b|\brunning\b\s*(?:\+\+|<|>)/;
const QUEUE_PATTERN = /\bqueue\s*\.\s*(?:push|shift)\s*\(|\bwaiting\s*\.\s*(?:push|shift)\s*\(|\bpending\s*\.\s*(?:push|shift)\s*\(/;
const RELEASE_PATTERN = /\brelease\s*\(|finally\s*\{/;

export function buildHandRolledConcurrencyLimitEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HandRolledConcurrencyLimitEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const facts = manifestFacts(projectFiles, candidate.filePath, LIMITER_DEPS);
  if (!facts.matchedDep) return undefined;
  if (facts.candidateImportsDep) return undefined;

  const signals: ConcurrencyLimitSignal[] = [];
  const counter = ACTIVE_COUNTER_PATTERN.exec(candidate.source);
  if (counter) signals.push({ signal: "active-counter", excerpt: counter[0].slice(0, 200) });
  const queue = QUEUE_PATTERN.exec(candidate.source);
  if (queue) signals.push({ signal: "waiting-queue", excerpt: queue[0].slice(0, 200) });
  const release = RELEASE_PATTERN.exec(candidate.source);
  if (release) signals.push({ signal: "acquire-release", excerpt: release[0].slice(0, 200) });

  if (!counter || !queue) return undefined;

  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    ownedLimiterDep: facts.matchedDep,
    siblingImporters: facts.siblingImporters,
    lockfilePresent: facts.lockfilePresent,
    signals,
    callers,
  };
}
