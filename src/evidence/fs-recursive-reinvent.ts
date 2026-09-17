import { parseSync, Visitor } from "oxc-parser";
import type { CallExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type FsRecursiveReinventEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  operation: "recursive-remove" | "recursive-make" | "recursive-walk";
  reinventSignals: string[];
  filtering: string[];
  toleratesEntryErrors: boolean;
  dryRun: boolean;
  callers: FunctionCaller[];
};

const RECURSIVE_OPTION_PATTERN = /recursive\s*:\s*true/;
const READDIR_PATTERN = /readdir(Sync)?\s*\(/;
const REMOVE_PATTERN = /\b(rm|rmdir|unlink)(Sync)?\s*\(/;
const MAKE_PATTERN = /\b(mkdir|mkdirSync)\s*\(/;
const EXISTS_PATTERN = /\bexistsSync\s*\(/;
const FILTER_PATTERNS: Array<[RegExp, string]> = [
  [/\.filter\s*\(/, "filter-call"],
  [/\.test\s*\(|match\s*\(|minimatch|micromatch|glob/i, "pattern-match"],
  [/\b(exclude|include|ignore|keep)\b/i, "keep-glob"],
];

export function buildFsRecursiveReinventEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): FsRecursiveReinventEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  // Already on the platform mechanism: nothing reinvented to score.
  if (RECURSIVE_OPTION_PATTERN.test(candidate.source)) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  let recursive = false;
  new Visitor({
    CallExpression(call: CallExpression) {
      if (recursive) return;
      if (call.start < candidate.start || call.end > candidate.end) return;
      if (!belongsDirectlyToFunction(call, nested)) return;
      if (call.callee.type !== "Identifier" || call.callee.name !== name) return;
      recursive = true;
    },
  }).visit(parsed.program);
  const readsDir = READDIR_PATTERN.test(candidate.source);
  const removes = REMOVE_PATTERN.test(candidate.source);
  const makes = MAKE_PATTERN.test(candidate.source);
  const checksExists = EXISTS_PATTERN.test(candidate.source);

  const reinventSignals: string[] = [];
  let operation: FsRecursiveReinventEvidence["operation"] | undefined;
  if (readsDir && recursive && removes) {
    operation = "recursive-remove";
    reinventSignals.push("readdir-traversal", "self-recursion", "entry-remove");
  } else if (checksExists && makes) {
    operation = "recursive-make";
    reinventSignals.push("exists-check", "mkdir-chain");
  } else if (readsDir && recursive) {
    operation = "recursive-walk";
    reinventSignals.push("readdir-traversal", "self-recursion");
  } else if (removes && recursive) {
    operation = "recursive-remove";
    reinventSignals.push("self-recursion", "entry-remove");
  }
  if (!operation) return undefined;

  const filtering = FILTER_PATTERNS
    .filter(([pattern]) => pattern.test(candidate.source))
    .map(([, label]) => label);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    operation,
    reinventSignals,
    filtering,
    toleratesEntryErrors: /\btry\b/.test(candidate.source),
    dryRun: /dry[-_ ]?run/i.test(candidate.source),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
