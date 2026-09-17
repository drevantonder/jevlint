import { Visitor } from "oxc-parser";
import type { CallExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  calleeRootName,
  isInsideNestedFunction,
  nestedFunctionRanges,
} from "./repository.js";
import { parseTestFunction } from "./test-scope.js";

export type ConcurrentUnitEvidence = {
  expression: string;
  kind: "promise" | "callback" | "event";
  synchronized: boolean;
};

export type FlakyOrderAssertionEvidence = {
  function: {
    title: string | null;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  concurrentUnits: ConcurrentUnitEvidence[];
  orderAssertions: string[];
  syncSignals: string[];
};

function callText(call: CallExpression, source: string): string {
  return source.slice(call.start, call.end).slice(0, 300);
}

function isAssertion(call: CallExpression): boolean {
  const root = calleeRootName(call.callee);
  return root === "expect" || root === "assert";
}

function isOrderSensitive(assertion: string): boolean {
  return /\[\s*\d+\s*\]|#\s*\d+|\.\s*at\s*\(|toHaveBeenNthCalledWith|toHaveBeenLastCalledWith|toEqual\s*\(\s*\[|toStrictEqual\s*\(\s*\[|toMatchSnapshot|\.\s*join\s*\(|toMatchObject\s*\(\s*\[/.test(
    assertion,
  );
}

function unitKind(
  text: string,
  root: string | null,
  producers: Set<string>,
): ConcurrentUnitEvidence["kind"] | null {
  if (/\bnew\s+Promise\s*\(/.test(text)) return "promise";
  if (root === "setTimeout" || root === "setImmediate" || root === "setInterval") {
    return "callback";
  }
  if (/\.\s*(then|catch|finally)\s*\(/.test(text)) return "promise";
  if (root !== null && producers.has(root)) return "promise";
  if (/\b(fetch|request|dispatch|emit|publish|send|write|save|enqueue|schedule)\b/.test(text)) {
    return "event";
  }
  return null;
}

export function buildFlakyOrderAssertionEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): FlakyOrderAssertionEvidence | undefined {
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  if (scope.runner !== "it" && scope.runner !== "test") return undefined;
  const { owner, program, fn } = scope;
  const nested = nestedFunctionRanges(program, candidate);

  const syncSignals: string[] = [];
  if (/\bPromise\s*\.\s*(all|allSettled|race|any)\s*\(/.test(owner.source.slice(fn.start, fn.end))) {
    syncSignals.push("promise-combinator");
  }
  if (/\.\s*sort\s*\(/.test(owner.source.slice(fn.start, fn.end))) syncSignals.push("sorted-compare");
  if (/arrayContaining|setEquals|sameMembers|unordered/i.test(owner.source.slice(fn.start, fn.end))) {
    syncSignals.push("unordered-compare");
  }
  if (/\b(waitFor|waitUntil|eventually|barrier|gate|countdown|latch)\b/i.test(
    owner.source.slice(fn.start, fn.end),
  )) syncSignals.push("barrier");

  const awaitedNames = new Set<string>();
  const asyncProducers = new Set<string>();
  new Visitor({
    FunctionDeclaration(node) {
      const bodyText = node.body ? owner.source.slice(node.body.start, node.body.end) : "";
      if (node.async || /\bnew\s+Promise\s*\(/.test(bodyText)) {
        if (node.id?.name) asyncProducers.add(node.id.name);
      }
    },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || !node.init) return;
      if (
        node.init.type === "ArrowFunctionExpression"
        || node.init.type === "FunctionExpression"
      ) {
        const bodyText = owner.source.slice(node.init.start, node.init.end);
        if (node.init.async || /\bnew\s+Promise\s*\(/.test(bodyText)) {
          asyncProducers.add(node.id.name);
        }
      }
    },
  }).visit(program);
  new Visitor({
    AwaitExpression(node) {
      if (node.start < fn.start || node.end > fn.end) return;
      if (isInsideNestedFunction(node, nested)) return;
      const text = owner.source.slice(node.start, node.end);
      for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
        const name = match[1];
        if (name) awaitedNames.add(name);
      }
      if (/\bPromise\s*\.\s*(all|allSettled|race|any)\s*\(/.test(text)) {
        for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
          const name = match[1];
          if (name) awaitedNames.add(name);
        }
      }
    },
    VariableDeclarator(node) {
      if (node.start < fn.start || node.end > fn.end) return;
      if (isInsideNestedFunction(node, nested)) return;
      if (node.id.type !== "Identifier" || !node.init) return;
      if (node.init.type === "AwaitExpression") awaitedNames.add(node.id.name);
    },
  }).visit(program);

  const concurrentUnits: ConcurrentUnitEvidence[] = [];
  const orderAssertions: string[] = [];
  const seen = new Set<number>();
  new Visitor({
    CallExpression(call) {
      if (call.start < fn.start || call.end > fn.end) return;
      if (isInsideNestedFunction(call, nested)) return;
      const text = callText(call, owner.source);
      if (isAssertion(call)) {
        if (isOrderSensitive(text) && !seen.has(call.start)) {
          seen.add(call.start);
          orderAssertions.push(text);
        }
        return;
      }
      const kind = unitKind(text, calleeRootName(call.callee), asyncProducers);
      if (!kind || seen.has(call.start)) return;
      seen.add(call.start);
      const awaitedInPlace = /\bawait\b/.test(owner.source.slice(Math.max(fn.start, call.start - 6), call.start));
      const namesInCall = new Set(
        [...text.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].flatMap((match) =>
          match[1] === undefined ? [] : [match[1]],
        ),
      );
      const awaitedByName = [...namesInCall].some((name) => awaitedNames.has(name));
      const inCombinator = syncSignals.includes("promise-combinator")
        && /\bPromise\s*\.\s*(all|allSettled|race|any)\s*\(/.test(
          owner.source.slice(Math.max(fn.start, call.start - 200), Math.min(fn.end, call.end + 200)),
        );
      concurrentUnits.push({
        expression: text,
        kind,
        synchronized: awaitedInPlace || awaitedByName || inCombinator,
      });
    },
  }).visit(program);

  if (concurrentUnits.length < 2) return undefined;
  if (concurrentUnits.every((unit) => unit.synchronized)) return undefined;
  if (orderAssertions.length === 0) return undefined;

  return {
    function: {
      title: scope.title,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    concurrentUnits: concurrentUnits.slice(0, 10),
    orderAssertions: orderAssertions.slice(0, 10),
    syncSignals,
  };
}
