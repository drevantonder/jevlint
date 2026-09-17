import { parseSync } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { manifestFacts } from "./manifest-facts.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type DebounceSignal = {
  signal: string;
  excerpt: string;
};

export type HandRolledDebounceEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  ownedDebounceDep: string;
  siblingImporters: string[];
  lockfilePresent: boolean;
  signals: DebounceSignal[];
  optionCount: number;
  callers: FunctionCaller[];
};

const DEBOUNCE_DEPS = [
  "lodash",
  "lodash.debounce",
  "use-debounce",
  "debounce",
  "throttle-debounce",
  "es-toolkit",
];

const OPTION_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "leading-option", pattern: /\bleading\b\??\s*:/ },
  { name: "trailing-option", pattern: /\btrailing\b\??\s*:/ },
  { name: "max-wait-option", pattern: /\bmaxWait\b/ },
  { name: "cancel-method", pattern: /\bcancel\b\s*[=(]|\.\s*cancel\s*=/ },
  { name: "flush-method", pattern: /\bflush\b\s*[=(]|\.\s*flush\s*=/ },
];

export function buildHandRolledDebounceEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HandRolledDebounceEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const facts = manifestFacts(projectFiles, candidate.filePath, DEBOUNCE_DEPS);
  if (!facts.matchedDep) return undefined;
  if (facts.candidateImportsDep) return undefined;

  if (!/\bsetTimeout\s*\(/.test(candidate.source)) return undefined;
  if (!/\bclearTimeout\s*\(/.test(candidate.source)) return undefined;
  if (!/\breturn\b/.test(candidate.source) || !/=>/.test(candidate.source)) return undefined;

  const signals: DebounceSignal[] = [
    { signal: "timer-reset", excerpt: "setTimeout/clearTimeout" },
  ];
  for (const { name: signal, pattern } of OPTION_PATTERNS) {
    const match = pattern.exec(candidate.source);
    if (match) signals.push({ signal, excerpt: match[0].slice(0, 200) });
  }

  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    ownedDebounceDep: facts.matchedDep,
    siblingImporters: facts.siblingImporters,
    lockfilePresent: facts.lockfilePresent,
    signals,
    optionCount: signals.length - 1,
    callers,
  };
}
