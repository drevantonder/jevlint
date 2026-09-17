import { parseSync, Visitor } from "oxc-parser";
import type {
  CallExpression,
  CatchClause,
  ForInStatement,
  ForOfStatement,
  Node,
  Program,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type {
  FunctionCaller,
  FunctionNode,
  RelatedProjectModule,
} from "./repository.js";

type BatchLoop = ForInStatement | ForOfStatement;

type CatchEvidence = {
  caught: string | null;
  body: string;
  throws: string[];
};

type BatchMechanismEvidence = {
  kind: "all-settled" | "per-item-catch";
  source: string;
  iteration: string | null;
  resultBinding: string | null;
  continuation: string;
  statusLiterals: string[];
  calls: string[];
  catches: CatchEvidence[];
};

type ModuleContext = {
  filePath: string;
  source: string;
};

export type HiddenPartialFailureEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  batchMechanisms: BatchMechanismEvidence[];
  functionOutcomes: {
    returns: string[];
    throws: string[];
  };
  repository: {
    callers: FunctionCaller[];
    callerModules: ModuleContext[];
    relatedModules: RelatedProjectModule[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function isAllSettled(call: CallExpression): boolean {
  const callee = call.callee;
  return callee.type === "MemberExpression"
    && callee.object.type === "Identifier"
    && callee.object.name === "Promise"
    && callee.property.type === "Identifier"
    && callee.property.name === "allSettled";
}

function resultBinding(call: CallExpression, program: Program): string | null {
  let binding: string | null = null;
  let bindingSize = Number.POSITIVE_INFINITY;
  new Visitor({
    VariableDeclarator(declaration) {
      if (
        declaration.init
        && declaration.id.type === "Identifier"
        && containsNode(declaration.init, call)
      ) {
        const size = declaration.end - declaration.start;
        if (size < bindingSize) {
          binding = declaration.id.name;
          bindingSize = size;
        }
      }
    },
  }).visit(program);
  return binding;
}

function statusLiterals(range: NodeRange, program: Program): string[] {
  const statuses = new Set<string>();
  new Visitor({
    Literal(node) {
      if (!containsNode(range, node)) return;
      const value = String(node.value);
      if (value === "fulfilled" || value === "rejected") statuses.add(value);
    },
  }).visit(program);
  return [...statuses];
}

function callsWithin(
  range: NodeRange,
  program: Program,
  source: string,
  nested: NodeRange[],
): string[] {
  const calls: string[] = [];
  new Visitor({
    CallExpression(call) {
      if (containsNode(range, call) && belongsDirectlyToFunction(call, nested)) {
        calls.push(nodeSource(call, source));
      }
    },
  }).visit(program);
  return calls;
}

function caughtName(handler: CatchClause, source: string): string | null {
  return handler.param ? nodeSource(handler.param, source) : null;
}

function catchesWithin(
  range: NodeRange,
  program: Program,
  source: string,
  nested: NodeRange[],
): CatchEvidence[] {
  const catches: CatchEvidence[] = [];
  new Visitor({
    CatchClause(handler) {
      if (!containsNode(range, handler) || !belongsDirectlyToFunction(handler, nested)) return;
      const throws: string[] = [];
      new Visitor({
        ThrowStatement(node) {
          if (
            containsNode(handler.body, node)
            && belongsDirectlyToFunction(node, nested)
          ) throws.push(nodeSource(node, source));
        },
      }).visit(program);
      catches.push({
        caught: caughtName(handler, source),
        body: nodeSource(handler.body, source),
        throws,
      });
    },
  }).visit(program);
  return catches;
}

function allSettledEvidence(
  call: CallExpression,
  fn: FunctionNode,
  program: Program,
  source: string,
  nested: NodeRange[],
): BatchMechanismEvidence {
  const continuationRange = { start: call.end, end: fn.end };
  return {
    kind: "all-settled",
    source: nodeSource(call, source),
    iteration: null,
    resultBinding: resultBinding(call, program),
    continuation: source.slice(continuationRange.start, continuationRange.end),
    statusLiterals: statusLiterals(continuationRange, program),
    calls: callsWithin(call, program, source, nested),
    catches: [],
  };
}

function loopIteration(loop: BatchLoop, source: string): string {
  const operator = loop.type === "ForOfStatement" ? "of" : "in";
  return `${nodeSource(loop.left, source)} ${operator} ${nodeSource(loop.right, source)}`;
}

function perItemEvidence(
  loop: BatchLoop,
  fn: FunctionNode,
  program: Program,
  source: string,
  nested: NodeRange[],
): BatchMechanismEvidence | undefined {
  const catches = catchesWithin(loop, program, source, nested);
  if (catches.length === 0) return undefined;
  const continuationRange = { start: loop.end, end: fn.end };
  return {
    kind: "per-item-catch",
    source: nodeSource(loop, source),
    iteration: loopIteration(loop, source),
    resultBinding: null,
    continuation: source.slice(continuationRange.start, continuationRange.end),
    statusLiterals: statusLiterals(continuationRange, program),
    calls: callsWithin(loop, program, source, nested),
    catches,
  };
}

function functionOutcomes(
  fn: FunctionNode,
  program: Program,
  source: string,
  nested: NodeRange[],
): HiddenPartialFailureEvidence["functionOutcomes"] {
  const returns: string[] = [];
  const throws: string[] = [];
  new Visitor({
    ReturnStatement(node) {
      if (containsNode(fn, node) && belongsDirectlyToFunction(node, nested)) {
        returns.push(nodeSource(node, source));
      }
    },
    ThrowStatement(node) {
      if (containsNode(fn, node) && belongsDirectlyToFunction(node, nested)) {
        throws.push(nodeSource(node, source));
      }
    },
  }).visit(program);
  return { returns, throws };
}

function callerModules(
  callers: FunctionCaller[],
  projectFiles: ProjectFile[],
): ModuleContext[] {
  const paths = new Set(callers.map(({ filePath }) => filePath));
  return projectFiles
    .filter(({ filePath }) => paths.has(filePath))
    .slice(0, 12)
    .map(({ filePath, source }) => ({ filePath, source: source.slice(0, 12_000) }));
}

export function buildHiddenPartialFailureEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HiddenPartialFailureEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseSync(ownerFile.filePath, ownerFile.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const batchMechanisms: BatchMechanismEvidence[] = [];
  new Visitor({
    CallExpression(call) {
      if (
        containsNode(fn, call)
        && belongsDirectlyToFunction(call, nested)
        && isAllSettled(call)
      ) {
        batchMechanisms.push(allSettledEvidence(
          call,
          fn,
          parsed.program,
          ownerFile.source,
          nested,
        ));
      }
    },
    ForInStatement(loop) {
      if (!containsNode(fn, loop) || !belongsDirectlyToFunction(loop, nested)) return;
      const evidence = perItemEvidence(
        loop,
        fn,
        parsed.program,
        ownerFile.source,
        nested,
      );
      if (evidence) batchMechanisms.push(evidence);
    },
    ForOfStatement(loop) {
      if (!containsNode(fn, loop) || !belongsDirectlyToFunction(loop, nested)) return;
      const evidence = perItemEvidence(
        loop,
        fn,
        parsed.program,
        ownerFile.source,
        nested,
      );
      if (evidence) batchMechanisms.push(evidence);
    },
  }).visit(parsed.program);
  if (batchMechanisms.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  const callers = name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [];
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    batchMechanisms,
    functionOutcomes: functionOutcomes(fn, parsed.program, ownerFile.source, nested),
    repository: {
      callers,
      callerModules: callerModules(callers, projectFiles),
      relatedModules: findRelatedProjectModules(
        candidate.filePath,
        parsed.program,
        projectFiles,
      ),
    },
  };
}
