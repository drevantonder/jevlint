import { parseSync, Visitor } from "oxc-parser";
import type { AwaitExpression, CallExpression, Expression } from "oxc-parser";
import type { Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  isInsideNestedFunction,
  moduleImports,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

type LoopRange = {
  kind: string;
  start: number;
  end: number;
};

export type SerializedLoop = {
  loopKind: string;
  loop: string;
  awaitedCalls: string[];
  awaitedArguments: string[];
};

export type AccidentalSerializationEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  loops: SerializedLoop[];
  loopWritesOuterBinding: boolean;
  accumulationSignals: boolean;
  orderingSignals: {
    resultIndexedByElement: boolean;
    hasConcurrencyLimiter: boolean;
    sequencingComment: boolean;
  };
  calleeImportSources: (string | null)[];
  callers: FunctionCaller[];
};

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") return rootIdentifier(expression.object);
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  return undefined;
}

function awaitedCall(argument: Expression): CallExpression | undefined {
  const unwrapped = argument.type === "ChainExpression" ? argument.expression : argument;
  return unwrapped.type === "CallExpression" ? unwrapped : undefined;
}

const LIMITER_PATTERN = /p-limit|p-map|p-queue|semaphore|throttle|bottleneck|pLimit/i;
const SEQUENCING_PATTERN = /sequen|in order|in-order|one at a time|serially|rate.?limit/i;
const ACCUMULATION_PATTERN = /\+=|-=|\.push\s*\(|\+\+|--/;
const INDEXED_STORE_PATTERN = /\w+\s*\[[^\]]+\]\s*=/;

export function buildAccidentalSerializationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): AccidentalSerializationEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nestedFunctions = nestedFunctionRanges(parsed.program, candidate);
  const inScope = (node: Node): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !isInsideNestedFunction(node, nestedFunctions);

  const loops: LoopRange[] = [];
  const recordLoop = (kind: string) => (node: Node): void => {
    if (inScope(node)) loops.push({ kind, start: node.start, end: node.end });
  };
  const awaits: AwaitExpression[] = [];
  new Visitor({
    ForStatement: recordLoop("for"),
    ForOfStatement: recordLoop("for-of"),
    ForInStatement: recordLoop("for-in"),
    AwaitExpression(node) {
      if (inScope(node)) awaits.push(node);
    },
  }).visit(parsed.program);
  if (loops.length === 0 || awaits.length === 0) return undefined;

  const awaitsByLoop = loops.map((loop) =>
    awaits.filter((awaited) => awaited.start >= loop.start && awaited.end <= loop.end),
  );
  const hitLoops = loops.filter((_, index) => (awaitsByLoop[index]?.length ?? 0) > 0);
  if (hitLoops.length === 0) return undefined;

  const imports = moduleImports(parsed.program);
  const serialized: SerializedLoop[] = [];
  const calleeImportSources: (string | null)[] = [];
  for (const loop of hitLoops) {
    const loopAwaits = awaits.filter(
      (awaited) => awaited.start >= loop.start && awaited.end <= loop.end,
    );
    const awaitedCalls: string[] = [];
    const awaitedArguments: string[] = [];
    for (const awaited of loopAwaits) {
      const call = awaitedCall(awaited.argument);
      if (call) {
        awaitedCalls.push(owner.source.slice(call.start, call.end).slice(0, 300));
        for (const argument of call.arguments) {
          awaitedArguments.push(owner.source.slice(argument.start, argument.end).slice(0, 200));
        }
        const root = rootIdentifier(call.callee);
        calleeImportSources.push(
          root === undefined
            ? null
            : (imports.find(({ local }) => local === root)?.source ?? null),
        );
      } else {
        awaitedCalls.push(owner.source.slice(awaited.start, awaited.end).slice(0, 300));
        calleeImportSources.push(null);
      }
    }
    serialized.push({
      loopKind: loop.kind,
      loop: owner.source.slice(loop.start, loop.end).slice(0, 1_500),
      awaitedCalls,
      awaitedArguments,
    });
  }

  const outerBindings = new Set<string>();
  const assignedInLoops = new Set<string>();
  let accumulationSignals = false;
  new Visitor({
    VariableDeclarator(node) {
      if (
        node.id.type === "Identifier"
        && node.start >= candidate.start
        && node.end <= candidate.end
        && !hitLoops.some((loop) => node.start >= loop.start && node.end <= loop.end)
      ) outerBindings.add(node.id.name);
    },
  }).visit(parsed.program);
  for (const parameter of fn.params) {
    const text = owner.source.slice(parameter.start, parameter.end);
    const match = /^(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(text.trim());
    if (match?.[1]) outerBindings.add(match[1]);
  }
  new Visitor({
    AssignmentExpression(node) {
      if (!hitLoops.some((loop) => node.start >= loop.start && node.end <= loop.end)) return;
      if (node.left.type === "Identifier") assignedInLoops.add(node.left.name);
    },
    UpdateExpression(node) {
      if (!hitLoops.some((loop) => node.start >= loop.start && node.end <= loop.end)) return;
      accumulationSignals = true;
      if (node.argument.type === "Identifier") assignedInLoops.add(node.argument.name);
    },
    CallExpression(node) {
      if (!hitLoops.some((loop) => node.start >= loop.start && node.end <= loop.end)) return;
      if (
        node.callee.type === "MemberExpression"
        && node.callee.property.type === "Identifier"
        && node.callee.property.name === "push"
      ) accumulationSignals = true;
    },
  }).visit(parsed.program);
  if ([...assignedInLoops].some((binding) => outerBindings.has(binding))) {
    accumulationSignals = true;
  }
  const loopWritesOuterBinding = [...assignedInLoops].some((binding) =>
    outerBindings.has(binding),
  );

  const loopSources = hitLoops.map((loop) => owner.source.slice(loop.start, loop.end));
  const orderingSignals = {
    resultIndexedByElement: loopSources.some((text) => INDEXED_STORE_PATTERN.test(text)),
    hasConcurrencyLimiter:
      imports.some(({ source, local }) => LIMITER_PATTERN.test(source) || LIMITER_PATTERN.test(local))
      || LIMITER_PATTERN.test(owner.source.slice(candidate.start, candidate.end)),
    sequencingComment: parsed.comments.some(
      (comment) =>
        hitLoops.some((loop) => comment.start >= loop.start && comment.end <= loop.end)
        && SEQUENCING_PATTERN.test(comment.value),
    ),
  };
  if (loopSources.some((text) => ACCUMULATION_PATTERN.test(text))) accumulationSignals = true;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    loops: serialized,
    loopWritesOuterBinding,
    accumulationSignals,
    orderingSignals,
    calleeImportSources,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
