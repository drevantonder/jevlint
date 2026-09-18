import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CatchClause, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isInsideNestedFunction,
  nestedFunctionRanges,
} from "./repository.js";
import { isTestFilePath, findTransitiveTestPins, type TransitivePin } from "./test-scope.js";

export type FailurePathRecovery =
  | "maps-to-domain-error"
  | "rethrows"
  | "fallback-return"
  | "swallow-and-continue";

export type FailurePathEvidence =
  | { kind: "catch"; param: string | null; recovery: FailurePathRecovery; source: string }
  | { kind: "throw"; source: string }
  | { kind: "error-return"; source: string };

export type UnpinnedFailurePathEvidence = {
  function: {
    name: string;
    filePath: string;
    source: string;
  };
  failurePaths: FailurePathEvidence[];
  pinning: {
    testReferences: string[];
    testReferenceCount: number;
    callers: { filePath: string; call: string; line: number }[];
    /** Present only when a test reaches the function through a named seam. */
    transitivePins?: TransitivePin[];
  };
  relatedModules: { filePath: string; importedSymbols: string[]; source: string }[];
};

function slice(source: string, node: Node, max: number): string {
  return source.slice(node.start, node.end).slice(0, max);
}

function recoveryOf(handler: CatchClause, source: string): FailurePathRecovery {
  const body = source.slice(handler.body.start, handler.body.end);
  if (/\bthrow\b/.test(body)) {
    return /\bthrow\s+new\s/.test(body) ? "maps-to-domain-error" : "rethrows";
  }
  if (/\breturn\b/.test(body)) {
    return /Error|reject|fail|fallback|default/i.test(body) ? "maps-to-domain-error" : "fallback-return";
  }
  return "swallow-and-continue";
}

function isErrorReturn(argument: Node, source: string): boolean {
  if (argument.type === "NewExpression") {
    const callee = source.slice(argument.callee.start, argument.callee.end);
    return /Error$/i.test(callee.split(".").pop() ?? "");
  }
  if (
    argument.type === "CallExpression"
    && /\.reject\s*$/.test(source.slice(argument.callee.start, argument.callee.end))
  ) return true;
  if (argument.type === "Identifier") return /^(err|error|failure|rejection).*/i.test(argument.name);
  return false;
}

export function buildUnpinnedFailurePathEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnpinnedFailurePathEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  if (isTestFilePath(candidate.filePath)) return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  const nested = nestedFunctionRanges(parsed.program, candidate);

  const failurePaths: FailurePathEvidence[] = [];
  const catchRanges: { start: number; end: number }[] = [];
  new Visitor({
    CatchClause(node) {
      if (node.start < fn.start || node.end > fn.end) return;
      if (isInsideNestedFunction(node, nested)) return;
      catchRanges.push({ start: node.start, end: node.end });
      failurePaths.push({
        kind: "catch",
        param: node.param?.type === "Identifier" ? node.param.name : null,
        recovery: recoveryOf(node, owner.source),
        source: slice(owner.source, node, 500),
      });
    },
  }).visit(parsed.program);
  const insideCatch = (node: Node): boolean =>
    catchRanges.some((range) => range.start <= node.start && range.end >= node.end);

  new Visitor({
    ThrowStatement(node) {
      if (node.start < fn.start || node.end > fn.end) return;
      if (isInsideNestedFunction(node, nested)) return;
      if (insideCatch(node)) return;
      failurePaths.push({ kind: "throw", source: slice(owner.source, node, 300) });
    },
    ReturnStatement(node) {
      if (node.start < fn.start || node.end > fn.end) return;
      if (isInsideNestedFunction(node, nested)) return;
      if (insideCatch(node)) return;
      if (!node.argument || !isErrorReturn(node.argument, owner.source)) return;
      failurePaths.push({ kind: "error-return", source: slice(owner.source, node, 300) });
    },
  }).visit(parsed.program);

  if (failurePaths.length === 0) return undefined;

  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);
  const testReferences: string[] = [];
  const namePattern = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`);
  for (const file of projectFiles) {
    if (file.filePath === candidate.filePath) continue;
    if (!isTestFilePath(file.filePath)) continue;
    if (namePattern.test(file.source) && testReferences.length < 10) {
      testReferences.push(file.filePath);
    }
  }
  const testReferenceCount = projectFiles.filter(
    (file) =>
      file.filePath !== candidate.filePath
      && isTestFilePath(file.filePath)
      && namePattern.test(file.source),
  ).length;

  const pinning: UnpinnedFailurePathEvidence["pinning"] = {
    testReferences,
    testReferenceCount,
    callers: callers.slice(0, 10),
  };
  const transitivePins = findTransitiveTestPins(candidate.filePath, name, projectFiles);
  if (transitivePins.length > 0) pinning.transitivePins = transitivePins;

  return {
    function: {
      name,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    failurePaths: failurePaths.slice(0, 10),
    pinning,
    relatedModules: findRelatedProjectModules(candidate.filePath, parsed.program, projectFiles),
  };
}
