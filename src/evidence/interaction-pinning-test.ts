import { Visitor } from "oxc-parser";
import type { CallExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  calleeRootName,
  isInsideNestedFunction,
  nestedFunctionRanges,
} from "./repository.js";
import { parseTestFunction } from "./test-scope.js";

export type SpyTarget = {
  target: string;
  imported: boolean;
};

export type InteractionPinningTestEvidence = {
  function: {
    title: string | null;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  interactionAssertions: string[];
  outcomeAssertions: string[];
  spyTargets: SpyTarget[];
};

const INTERACTION_PATTERN = /\btoHaveBeenCalled|\btoHaveBeenNthCalled|\btoHaveBeenCalledTimes|\btoHaveBeenCalledWith|\btoHaveBeenLastCalledWith|\btoHaveBeenFirstCalledWith|\bcalledOnce\b|\bcalledTwice\b|\bcalledThrice\b|\bcalledWith\b|\bsinon\s*\.\s*assert\b/;

function callText(call: CallExpression, source: string): string {
  return source.slice(call.start, call.end);
}

function isAssertionCall(call: CallExpression): boolean {
  const root = calleeRootName(call.callee);
  if (root === "expect" || root === "assert") return true;
  const callee = call.callee;
  const property = callee.type === "MemberExpression" && callee.property.type === "Identifier"
    ? callee.property.name
    : null;
  return property !== null && /^to[A-Z]/.test(property);
}

function spyTarget(call: CallExpression, source: string): string | null {
  const text = callText(call, source);
  const match = /\bspyOn\s*\(\s*([A-Za-z_$][\w$]*)/.exec(text);
  return match?.[1] ?? null;
}

export function buildInteractionPinningTestEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): InteractionPinningTestEvidence | undefined {
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  if (scope.runner !== "it" && scope.runner !== "test") return undefined;
  const { owner, program, fn } = scope;
  const nested = nestedFunctionRanges(program, candidate);

  const interactionAssertions: string[] = [];
  const outcomeAssertions: string[] = [];
  const spyTargets: SpyTarget[] = [];
  const seenSpies = new Set<string>();
  const assertionCalls: { start: number; end: number; text: string }[] = [];
  new Visitor({
    CallExpression(call) {
      if (call.start < fn.start || call.end > fn.end) return;
      if (isInsideNestedFunction(call, nested)) return;
      const target = spyTarget(call, owner.source);
      if (target && !seenSpies.has(target)) {
        seenSpies.add(target);
        const imported = new RegExp(`\\bimport\\b[^;]*\\b${target.replace(/\$/g, "\\$")}\\b`).test(owner.source);
        spyTargets.push({ target, imported });
      }
      if (!isAssertionCall(call)) return;
      assertionCalls.push({ start: call.start, end: call.end, text: callText(call, owner.source) });
    },
  }).visit(program);

  const outermost = assertionCalls.filter((item) =>
    !assertionCalls.some((other) =>
      other !== item && other.start <= item.start && other.end >= item.end
      && (other.start < item.start || other.end > item.end)
    )
  );
  for (const item of outermost) {
    if (INTERACTION_PATTERN.test(item.text)) interactionAssertions.push(item.text.slice(0, 300));
    else outcomeAssertions.push(item.text.slice(0, 300));
  }

  if (interactionAssertions.length === 0 && outcomeAssertions.length === 0) return undefined;

  return {
    function: {
      title: scope.title,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    interactionAssertions: interactionAssertions.slice(0, 10),
    outcomeAssertions: outcomeAssertions.slice(0, 10),
    spyTargets: spyTargets.slice(0, 10),
  };
}
