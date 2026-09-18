import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type {
  CallExpression,
  CatchClause,
  DoWhileStatement,
  ForStatement,
  Node,
  Program,
  WhileStatement,
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
  RelatedProjectModule,
} from "./repository.js";

type RetryLoop = ForStatement | WhileStatement | DoWhileStatement;

type CatchEvidence = {
  caught: string | null;
  body: string;
  guards: string[];
  throws: string[];
};

type RetryMechanismEvidence = {
  kind: "loop" | "retry-call";
  control: string | null;
  source: string;
  calls: string[];
  catches: CatchEvidence[];
  delayCalls: string[];
  idempotencySignals: string[];
};

export type UnsafeRetryEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  retryMechanisms: RetryMechanismEvidence[];
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function loopControl(loop: RetryLoop, source: string): string {
  if (loop.type === "ForStatement") {
    const parts = [loop.init, loop.test, loop.update]
      .map((part) => part ? nodeSource(part, source) : "");
    return parts.join("; ");
  }
  return nodeSource(loop.test, source);
}

function finalCalleeName(expression: CallExpression["callee"]): string | null {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    if (expression.property.type === "Identifier") return expression.property.name;
    if (expression.property.type === "Literal") return String(expression.property.value);
  }
  if (expression.type === "ChainExpression") {
    const chained = expression.expression;
    if (chained.type === "CallExpression") return finalCalleeName(chained.callee);
    if (chained.type === "MemberExpression") {
      if (chained.property.type === "Identifier") return chained.property.name;
      if (chained.property.type === "Literal") return String(chained.property.value);
    }
  }
  return null;
}

function isRetryCall(call: CallExpression): boolean {
  const name = finalCalleeName(call.callee);
  return name !== null && /retry/i.test(name);
}

function isDelayCall(call: CallExpression): boolean {
  const name = finalCalleeName(call.callee);
  return name !== null && /^(?:sleep|delay|wait|backoff)$/i.test(name);
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
      const guards: string[] = [];
      const throws: string[] = [];
      new Visitor({
        IfStatement(node) {
          if (
            containsNode(handler.body, node)
            && belongsDirectlyToFunction(node, nested)
          ) guards.push(nodeSource(node, source));
        },
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
        guards,
        throws,
      });
    },
  }).visit(program);
  return catches;
}

function callsWithin(
  range: NodeRange,
  program: Program,
  nested: NodeRange[],
): CallExpression[] {
  const calls: CallExpression[] = [];
  new Visitor({
    CallExpression(call) {
      if (containsNode(range, call) && belongsDirectlyToFunction(call, nested)) calls.push(call);
    },
  }).visit(program);
  return calls;
}

function idempotencySignals(
  range: NodeRange,
  program: Program,
  nested: NodeRange[],
): string[] {
  const signals = new Set<string>();
  new Visitor({
    Identifier(node) {
      if (
        containsNode(range, node)
        && belongsDirectlyToFunction(node, nested)
        && /idempoten/i.test(node.name)
      ) signals.add(node.name);
    },
  }).visit(program);
  return [...signals];
}

function loopEvidence(
  loop: RetryLoop,
  program: Program,
  source: string,
  nested: NodeRange[],
): RetryMechanismEvidence | undefined {
  const catches = catchesWithin(loop, program, source, nested);
  if (catches.length === 0) return undefined;
  const calls = callsWithin(loop, program, nested);
  return {
    kind: "loop",
    control: loopControl(loop, source),
    source: nodeSource(loop, source),
    calls: calls.map((call) => nodeSource(call, source)),
    catches,
    delayCalls: calls.filter(isDelayCall).map((call) => nodeSource(call, source)),
    idempotencySignals: idempotencySignals(loop, program, nested),
  };
}

function retryCallEvidence(
  call: CallExpression,
  source: string,
  program: Program,
  nested: NodeRange[],
): RetryMechanismEvidence {
  return {
    kind: "retry-call",
    control: null,
    source: nodeSource(call, source),
    calls: [nodeSource(call, source)],
    catches: [],
    delayCalls: [],
    idempotencySignals: idempotencySignals(call, program, nested),
  };
}

export function buildUnsafeRetryEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnsafeRetryEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const loopRanges: NodeRange[] = [];
  const retryMechanisms: RetryMechanismEvidence[] = [];
  const addLoop = (loop: RetryLoop): void => {
    if (!containsNode(fn, loop) || !belongsDirectlyToFunction(loop, nested)) return;
    const evidence = loopEvidence(loop, parsed.program, ownerFile.source, nested);
    if (!evidence) return;
    loopRanges.push(loop);
    retryMechanisms.push(evidence);
  };
  new Visitor({
    DoWhileStatement: addLoop,
    ForStatement: addLoop,
    WhileStatement: addLoop,
  }).visit(parsed.program);

  new Visitor({
    CallExpression(call) {
      if (
        !containsNode(fn, call)
        || !belongsDirectlyToFunction(call, nested)
        || !isRetryCall(call)
        || loopRanges.some((loop) => containsNode(loop, call))
      ) return;
      retryMechanisms.push(retryCallEvidence(
        call,
        ownerFile.source,
        parsed.program,
        nested,
      ));
    },
  }).visit(parsed.program);
  if (retryMechanisms.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    retryMechanisms,
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(
        candidate.filePath,
        parsed.program,
        projectFiles,
      ),
    },
  };
}
