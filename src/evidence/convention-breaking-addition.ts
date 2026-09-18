import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  functionName,
  isFunctionExported,
} from "./repository.js";

export type ConventionSignals = {
  awaits: number;
  thenChains: number;
  throws: number;
  errorReturns: number;
  requires: number;
  imports: number;
  singleQuotes: number;
  doubleQuotes: number;
};

export type ConventionDivergence = {
  signal: "async-style" | "error-signaling" | "module-system" | "quote-style";
  moduleNorm: string;
  candidateChoice: string;
};

export type ConventionBreakingAdditionEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  candidateSignals: ConventionSignals;
  moduleSignals: ConventionSignals;
  divergences: ConventionDivergence[];
};

const EMPTY: ConventionSignals = {
  awaits: 0,
  thenChains: 0,
  throws: 0,
  errorReturns: 0,
  requires: 0,
  imports: 0,
  singleQuotes: 0,
  doubleQuotes: 0,
};

function countSignals(text: string, includeImports: boolean): ConventionSignals {
  const signals: ConventionSignals = { ...EMPTY };
  for (const match of text.matchAll(/\bawait\b/g)) {
    void match;
    signals.awaits += 1;
  }
  for (const match of text.matchAll(/\.then\s*\(/g)) {
    void match;
    signals.thenChains += 1;
  }
  for (const match of text.matchAll(/\bthrow\b/g)) {
    void match;
    signals.throws += 1;
  }
  for (const match of text.matchAll(/return\s+(null|undefined|\{\s*error|\{\s*ok\s*:\s*false)/g)) {
    void match;
    signals.errorReturns += 1;
  }
  for (const match of text.matchAll(/\brequire\s*\(/g)) {
    void match;
    signals.requires += 1;
  }
  if (includeImports) {
    for (const match of text.matchAll(/^import\s/mg)) {
      void match;
      signals.imports += 1;
    }
  }
  for (const match of text.matchAll(/'(?:[^'\\]|\\.)*'/g)) {
    void match;
    signals.singleQuotes += 1;
  }
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    void match;
    signals.doubleQuotes += 1;
  }
  return signals;
}

function signalTotal(signals: ConventionSignals): number {
  return signals.awaits + signals.thenChains + signals.throws + signals.errorReturns
    + signals.requires + signals.imports + signals.singleQuotes + signals.doubleQuotes;
}

function divergencesFor(
  candidateSignals: ConventionSignals,
  moduleSignals: ConventionSignals,
): ConventionDivergence[] {
  const divergences: ConventionDivergence[] = [];
  const candidateAsync = candidateSignals.awaits + candidateSignals.thenChains;
  const moduleAsync = moduleSignals.awaits + moduleSignals.thenChains;
  if (candidateAsync > 0 && moduleAsync >= 2) {
    const candidateStyle = candidateSignals.awaits >= candidateSignals.thenChains ? "await" : "then-chains";
    const moduleStyle = moduleSignals.awaits >= moduleSignals.thenChains ? "await" : "then-chains";
    if (candidateStyle !== moduleStyle) {
      divergences.push({ signal: "async-style", moduleNorm: moduleStyle, candidateChoice: candidateStyle });
    }
  }
  const candidateErrors = candidateSignals.throws + candidateSignals.errorReturns;
  const moduleErrors = moduleSignals.throws + moduleSignals.errorReturns;
  if (candidateErrors > 0 && moduleErrors >= 2) {
    const candidateStyle = candidateSignals.throws >= candidateSignals.errorReturns ? "throw" : "error-return";
    const moduleStyle = moduleSignals.throws >= moduleSignals.errorReturns ? "throw" : "error-return";
    if (candidateStyle !== moduleStyle) {
      divergences.push({ signal: "error-signaling", moduleNorm: moduleStyle, candidateChoice: candidateStyle });
    }
  }
  if (candidateSignals.requires > 0 && moduleSignals.imports >= 1 && moduleSignals.requires === 0) {
    divergences.push({ signal: "module-system", moduleNorm: "import", candidateChoice: "require" });
  }
  const candidateQuotes = candidateSignals.singleQuotes + candidateSignals.doubleQuotes;
  const moduleQuotes = moduleSignals.singleQuotes + moduleSignals.doubleQuotes;
  if (candidateQuotes > 0 && moduleQuotes >= 2) {
    const candidateStyle = candidateSignals.singleQuotes >= candidateSignals.doubleQuotes ? "single" : "double";
    const moduleStyle = moduleSignals.singleQuotes >= moduleSignals.doubleQuotes ? "single" : "double";
    if (candidateStyle !== moduleStyle) {
      divergences.push({ signal: "quote-style", moduleNorm: moduleStyle, candidateChoice: candidateStyle });
    }
  }
  return divergences;
}

export function buildConventionBreakingAdditionEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ConventionBreakingAdditionEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const candidateSignals = countSignals(candidate.source, false);
  const outside = ownerFile.source.slice(0, candidate.start)
    + "\n"
    + ownerFile.source.slice(candidate.end);
  const moduleSignals = countSignals(outside, true);

  if (signalTotal(candidateSignals) === 0 || signalTotal(moduleSignals) === 0) {
    return undefined;
  }

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    candidateSignals,
    moduleSignals,
    divergences: divergencesFor(candidateSignals, moduleSignals),
  };
}
