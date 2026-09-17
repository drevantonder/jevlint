import { Visitor } from "oxc-parser";
import type { CallExpression, NewExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  calleeRootName,
  isInsideNestedFunction,
  nestedFunctionRanges,
} from "./repository.js";
import { parseTestFunction } from "./test-scope.js";

export type NondeterministicReadEvidence = {
  expression: string;
  kind: "math-random" | "date-now" | "new-date" | "crypto-random" | "performance-now";
};

export type NondeterministicTestInputEvidence = {
  function: {
    title: string | null;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  reads: NondeterministicReadEvidence[];
  assertions: string[];
  flowsIntoAssertion: boolean;
  seededPrng: boolean;
  fakeTimers: boolean;
};

function callText(call: CallExpression | NewExpression, source: string): string {
  return source.slice(call.start, call.end).slice(0, 300);
}

function callKind(
  call: CallExpression,
  source: string,
): NondeterministicReadEvidence["kind"] | null {
  const text = source.slice(call.start, call.end);
  const root = calleeRootName(call.callee);
  if (root === "Math" && /\.\s*random\s*\(/.test(text)) return "math-random";
  if (root === "Date" && /\.\s*now\s*\(/.test(text)) return "date-now";
  if (root === "crypto" && /\.\s*(getRandomValues|randomUUID)\s*\(/.test(text)) {
    return "crypto-random";
  }
  if (root === "performance" && /\.\s*now\s*\(/.test(text)) return "performance-now";
  return null;
}

function assertionRoot(call: CallExpression): boolean {
  const root = calleeRootName(call.callee);
  return root === "expect" || root === "assert";
}

export function buildNondeterministicTestInputEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): NondeterministicTestInputEvidence | undefined {
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  if (scope.runner !== "it" && scope.runner !== "test") return undefined;
  const { owner, program, fn } = scope;
  const nested = nestedFunctionRanges(program, candidate);

  const reads: NondeterministicReadEvidence[] = [];
  const assertions: string[] = [];
  const nondetNames = new Set<string>();
  const seen = new Set<number>();
  new Visitor({
    CallExpression(call) {
      if (call.start < fn.start || call.end > fn.end) return;
      if (isInsideNestedFunction(call, nested)) return;
      const kind = callKind(call, owner.source);
      if (kind && !seen.has(call.start)) {
        seen.add(call.start);
        reads.push({ expression: callText(call, owner.source), kind });
        return;
      }
      if (assertionRoot(call) && !seen.has(call.start)) {
        seen.add(call.start);
        assertions.push(callText(call, owner.source));
      }
    },
    NewExpression(node) {
      if (node.start < fn.start || node.end > fn.end) return;
      if (isInsideNestedFunction(node, nested)) return;
      const callee = node.callee;
      const name = callee.type === "Identifier" ? callee.name : null;
      if (name === "Date" && !seen.has(node.start)) {
        seen.add(node.start);
        reads.push({ expression: callText(node, owner.source), kind: "new-date" });
      }
    },
    VariableDeclarator(node) {
      if (node.start < fn.start || node.end > fn.end) return;
      if (isInsideNestedFunction(node, nested)) return;
      if (node.id.type !== "Identifier" || !node.init) return;
      const initText = owner.source.slice(node.init.start, node.init.end);
      if (
        /Math\s*\.\s*random|Date\s*\.\s*now|new\s+Date|crypto\s*\.\s*(getRandomValues|randomUUID)|performance\s*\.\s*now/.test(
          initText,
        )
      ) nondetNames.add(node.id.name);
    },
  }).visit(program);

  if (reads.length === 0) return undefined;

  const flowsIntoAssertion = assertions.some((assertion) =>
    [...nondetNames].some((name) => new RegExp(`\\b${name}\\b`).test(assertion)),
  );
  const seededPrng = /seedrandom|faker\s*\.\s*seed|setSeed|withSeed|mulberry32|Chance\s*\(\s*["'\d]|Math\s*\.\s*random\s*=|Date\s*\.\s*now\s*=|jest\s*\.\s*spyOn\s*\(\s*(Math|Date)|vi\s*\.\s*spyOn\s*\(\s*(Math|Date)/.test(
    owner.source,
  );
  const fakeTimers = /useFakeTimers|setSystemTime|mockDate|MockDate|sinon\s*\.\s*useFakeTimers|clock\s*\.\s*(tick|set)|vi\s*\.\s*setSystemTime/.test(
    owner.source,
  );

  return {
    function: {
      title: scope.title,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    reads,
    assertions: assertions.slice(0, 10),
    flowsIntoAssertion,
    seededPrng,
    fakeTimers,
  };
}
