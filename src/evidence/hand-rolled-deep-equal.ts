import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import { containsNode } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type HandRolledDeepEqualEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  keyLengthCheck: boolean;
  keyIteration: string | null;
  recursiveCall: boolean;
  ownedCapability: {
    fileImportsAssertOrUtil: boolean;
    projectImportsDeepEqualDep: string[];
  };
  justification: {
    domainComparator: boolean;
    zeroDepFootprint: boolean;
  };
  callers: FunctionCaller[];
};

const DEEP_EQUAL_DEPS = new Set([
  "lodash.isequal",
  "lodash/isEqual",
  "fast-deep-equal",
  "deep-equal",
  "dequal",
  "underscore",
  "lodash",
]);

const DOMAIN_COMPARATOR_PATTERN =
  /\bepsilon\b|\btolerance\b|toBeCloseTo|Math\.abs\s*\(|\.sort\s*\(\s*\)|localeCompare|toLowerCase\s*\(|pick\s*\(|omit\s*\(|subset|ignore\w*(Keys|Order|Case)/;

const KEY_ITERATION_PATTERN = /Object\.keys\s*\(|Object\.entries\s*\(|for\s*\(\s*(const|let|var)\s+\w+\s+(in|of)\b/;

function projectDeepEqualImports(projectFiles: ProjectFile[]): string[] {
  const found = new Set<string>();
  for (const file of projectFiles) {
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    for (const imported of moduleImports(parsed.program)) {
      if (
        DEEP_EQUAL_DEPS.has(imported.source)
        || imported.source === "node:assert"
        || imported.source === "node:util"
        || imported.source === "assert"
        || imported.source === "util"
      ) found.add(imported.source);
    }
  }
  return [...found].slice(0, 10);
}

export function buildHandRolledDeepEqualEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HandRolledDeepEqualEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const source = owner.source;
  const functionText = source.slice(candidate.start, candidate.end);

  const keyLengthCheck = /Object\.keys\s*\([^)]*\)\.length/.test(functionText);
  const iterationMatch = KEY_ITERATION_PATTERN.exec(functionText);
  if (!keyLengthCheck && !iterationMatch) return undefined;

  const name = functionName(parsed.program, fn);
  let recursiveCall = false;
  new Visitor({
    CallExpression(call) {
      if (!containsNode(fn, call) || recursiveCall) return;
      const callee = call.callee.type === "ChainExpression" ? call.callee.expression : call.callee;
      if (name && callee.type === "Identifier" && callee.name === name) recursiveCall = true;
    },
  }).visit(parsed.program);
  if (!recursiveCall) return undefined;

  const ownerImports = moduleImports(parsed.program).map(({ source: from }) => from);
  const fileImportsAssertOrUtil = ownerImports.some((from) =>
    from === "node:assert" || from === "node:util" || from === "assert" || from === "util"
  );

  const projectDeps = projectDeepEqualImports(projectFiles);

  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    keyLengthCheck,
    keyIteration: iterationMatch?.[0].slice(0, 60) ?? null,
    recursiveCall,
    ownedCapability: {
      fileImportsAssertOrUtil,
      projectImportsDeepEqualDep: projectDeps,
    },
    justification: {
      domainComparator: DOMAIN_COMPARATOR_PATTERN.test(functionText),
      zeroDepFootprint: !fileImportsAssertOrUtil && projectDeps.length === 0,
    },
    callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
  };
}
