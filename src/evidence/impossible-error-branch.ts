import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Expression, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import {
  calleeRootName,
  findDirectFunction,
  findFunctionCallers,
  findNamedFunction,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
  type FunctionNode,
} from "./repository.js";

export type GuardedCallee = {
  call: string;
  callee: string;
  ownership: "same-module" | "project-module" | "external-package" | "unresolved";
  resolvedFile: string | null;
  analyzable: boolean;
  throwsFound: string[];
  rejectsFound: string[];
};

export type ErrorBranchHandler = {
  kind: "try-catch" | "promise-catch";
  source: string;
  guardedCalls: GuardedCallee[];
  allCalleesClean: boolean;
};

export type ImpossibleErrorBranchEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  handlers: ErrorBranchHandler[];
  boundary: {
    callerCount: number;
    crossModuleCallerCount: number;
  };
};

const MAX_DEPTH = 2;

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") return rootIdentifier(expression.object);
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  return undefined;
}

function memberProperty(call: CallExpression): string | undefined {
  const callee = call.callee.type === "ChainExpression" ? call.callee.expression : call.callee;
  if (callee.type !== "MemberExpression") return undefined;
  if (callee.property.type === "Identifier" && !callee.computed) return callee.property.name;
  return undefined;
}

type CalleeTarget = {
  ownership: GuardedCallee["ownership"];
  file: ProjectFile | undefined;
  program: Program | undefined;
  name: string | undefined;
};

function resolveCallee(
  call: CallExpression,
  ownerPath: string,
  program: Program,
  projectFiles: ProjectFile[],
): CalleeTarget {
  const property = memberProperty(call);
  const root = rootIdentifier(call.callee) ?? calleeRootName(call.callee) ?? undefined;
  const imports = moduleImports(program);
  const entry = root === undefined ? undefined : imports.find(({ local }) => local === root);
  if (entry && !entry.source.startsWith(".")) {
    return { ownership: "external-package", file: undefined, program: undefined, name: undefined };
  }
  if (entry) {
    const file = resolveModule(ownerPath, entry.source, projectFiles);
    if (!file) return { ownership: "unresolved", file: undefined, program: undefined, name: undefined };
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) {
      return { ownership: "project-module", file, program: undefined, name: undefined };
    }
    const name = property ?? (entry.imported !== "default" && entry.imported !== "*" ? entry.imported : undefined);
    return { ownership: "project-module", file, program: parsed.program, name };
  }
  const owner = projectFiles.find((file) => file.filePath === ownerPath);
  if (!owner) return { ownership: "unresolved", file: undefined, program: undefined, name: undefined };
  return { ownership: "same-module", file: owner, program, name: property ?? root };
}

type FailureCapability = {
  throwsFound: string[];
  rejectsFound: string[];
};

function scanFailureCapability(
  fn: FunctionNode,
  program: Program,
  source: string,
  ownerPath: string,
  projectFiles: ProjectFile[],
  depth: number,
  visited: Set<string>,
): FailureCapability {
  const throwsFound: string[] = [];
  const rejectsFound: string[] = [];
  new Visitor({
    ThrowStatement(node) {
      if (containsNode(fn, node)) throwsFound.push(source.slice(node.start, node.end).slice(0, 160));
    },
    CallExpression(node) {
      if (!containsNode(fn, node)) return;
      if (memberProperty(node) === "reject") {
        rejectsFound.push(source.slice(node.start, node.end).slice(0, 160));
      }
    },
  }).visit(program);
  if (depth <= 0) return { throwsFound, rejectsFound };
  const nested = nestedFunctionRanges(program, fn);
  const innerCalls: CallExpression[] = [];
  new Visitor({
    CallExpression(node) {
      if (containsNode(fn, node) && belongsDirectlyToFunction(node, nested)) innerCalls.push(node);
    },
  }).visit(program);
  for (const inner of innerCalls.slice(0, 20)) {
    const target = resolveCallee(inner, ownerPath, program, projectFiles);
    if (!target.program || !target.name || !target.file) continue;
    const key = `${target.file.filePath}::${target.name}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const innerFn = findNamedFunction(target.program, target.name);
    if (!innerFn) continue;
    const transitive = scanFailureCapability(
      innerFn,
      target.program,
      target.file.source,
      target.file.filePath,
      projectFiles,
      depth - 1,
      visited,
    );
    throwsFound.push(...transitive.throwsFound);
    rejectsFound.push(...transitive.rejectsFound);
  }
  return { throwsFound, rejectsFound };
}

function toGuardedCallee(
  call: CallExpression,
  ownerPath: string,
  program: Program,
  ownerSource: string,
  projectFiles: ProjectFile[],
): GuardedCallee {
  const text = ownerSource.slice(call.start, call.end).slice(0, 200);
  const target = resolveCallee(call, ownerPath, program, projectFiles);
  if (!target.program || !target.name || !target.file) {
    return {
      call: text,
      callee: target.name ?? rootIdentifier(call.callee) ?? memberProperty(call) ?? "<unknown>",
      ownership: target.ownership,
      resolvedFile: target.file?.filePath ?? null,
      analyzable: false,
      throwsFound: [],
      rejectsFound: [],
    };
  }
  const fn = findNamedFunction(target.program, target.name);
  if (!fn) {
    return {
      call: text,
      callee: target.name,
      ownership: target.ownership,
      resolvedFile: target.file.filePath,
      analyzable: false,
      throwsFound: [],
      rejectsFound: [],
    };
  }
  const capability = scanFailureCapability(
    fn,
    target.program,
    target.file.source,
    target.file.filePath,
    projectFiles,
    MAX_DEPTH,
    new Set([`${target.file.filePath}::${target.name}`]),
  );
  return {
    call: text,
    callee: target.name,
    ownership: target.ownership,
    resolvedFile: target.file.filePath,
    analyzable: true,
    throwsFound: capability.throwsFound.slice(0, 5),
    rejectsFound: capability.rejectsFound.slice(0, 5),
  };
}

export function buildImpossibleErrorBranchEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ImpossibleErrorBranchEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const nested = nestedFunctionRanges(parsed.program, fn);

  const handlers: ErrorBranchHandler[] = [];

  new Visitor({
    TryStatement(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (!node.handler) return;
      const guarded: CallExpression[] = [];
      new Visitor({
        CallExpression(call) {
          if (
            containsNode(node.block, call)
            && belongsDirectlyToFunction(call, nested)
          ) guarded.push(call);
        },
      }).visit(parsed.program);
      const guardedCalls = guarded
        .slice(0, 10)
        .map((call) => toGuardedCallee(call, owner.filePath, parsed.program, owner.source, projectFiles));
      const analyzable = guardedCalls.filter(({ analyzable }) => analyzable);
      if (analyzable.length === 0) return;
      handlers.push({
        kind: "try-catch",
        source: owner.source.slice(node.start, node.end).slice(0, 300),
        guardedCalls,
        allCalleesClean: analyzable.every(({ throwsFound, rejectsFound }) =>
          throwsFound.length === 0 && rejectsFound.length === 0
        ),
      });
    },
    CallExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (memberProperty(node) !== "catch") return;
      const callee = node.callee.type === "ChainExpression" ? node.callee.expression : node.callee;
      if (callee.type !== "MemberExpression") return;
      const receiver = callee.object.type === "ChainExpression" ? callee.object.expression : callee.object;
      if (receiver.type !== "CallExpression") return;
      const guardedCalls = [
        toGuardedCallee(receiver, owner.filePath, parsed.program, owner.source, projectFiles),
      ];
      if (guardedCalls.every(({ analyzable }) => !analyzable)) return;
      handlers.push({
        kind: "promise-catch",
        source: owner.source.slice(node.start, node.end).slice(0, 300),
        guardedCalls,
        allCalleesClean: guardedCalls.every(({ throwsFound, rejectsFound }) =>
          throwsFound.length === 0 && rejectsFound.length === 0
        ),
      });
    },
  }).visit(parsed.program);

  if (handlers.length === 0) return undefined;
  const name = functionName(parsed.program, fn);
  const callers = name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [];
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    handlers: handlers.slice(0, 5),
    boundary: {
      callerCount: callers.length,
      crossModuleCallerCount: callers.filter(({ filePath }) => filePath !== candidate.filePath).length,
    },
  };
}
