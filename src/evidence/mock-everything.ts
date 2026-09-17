import { Visitor } from "oxc-parser";
import type { CallExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  calleeRootName,
  isInsideNestedFunction,
  nestedFunctionRanges,
} from "./repository.js";
import { parseTestFunction } from "./test-scope.js";

export type TestDoubleEvidence = {
  expression: string;
  kind: "module-mock" | "fn-double" | "spy" | "stub";
  target: string | null;
};

export type MockEverythingEvidence = {
  function: {
    title: string | null;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  doubles: TestDoubleEvidence[];
  mockTargetNames: string[];
  mockOnlyAssertions: boolean;
  stateAssertions: string[];
  boundaryOnly: boolean;
};

function callText(call: CallExpression, source: string): string {
  return source.slice(call.start, call.end);
}

function stringArgument(call: CallExpression, source: string): string | null {
  const first = call.arguments[0];
  if (!first || first.type === "SpreadElement" || first.type !== "Literal") return null;
  return quotedInner(source.slice(first.start, first.end));
}

function quotedInner(raw: string): string | null {
  const quote = raw[0];
  if (quote !== "\"" && quote !== "'" && quote !== "`") return null;
  if (raw.length < 2 || raw[raw.length - 1] !== quote) return null;
  if (quote === "`" && raw.includes("${")) return null;
  return raw.slice(1, -1);
}

function classifyModuleCall(
  call: CallExpression,
  source: string,
): TestDoubleEvidence | null {
  const text = callText(call, source);
  const root = calleeRootName(call.callee);
  if (root === "vi" || root === "vitest" || root === "jest" || root === "sinon") {
    if (/\.\s*(mock|unmock|hoisted)\s*\(/.test(text)) {
      return {
        expression: text.slice(0, 300),
        kind: "module-mock",
        target: stringArgument(call, source),
      };
    }
    if (/\.\s*(fn|spyOn)\s*\(/.test(text)) {
      return {
        expression: text.slice(0, 300),
        kind: /\.\s*spyOn\s*\(/.test(text) ? "spy" : "fn-double",
        target: stringArgument(call, source),
      };
    }
    return null;
  }
  if (/\b(jest|vi)\s*\.\s*(fn|mock|spyOn)\s*\(/.test(text)) {
    return {
      expression: text.slice(0, 300),
      kind: text.includes("spyOn") ? "spy" : "fn-double",
      target: stringArgument(call, source),
    };
  }
  if (/\bsinon\s*\.\s*(stub|spy|mock|createStubInstance)\s*\(/.test(text)) {
    return {
      expression: text.slice(0, 300),
      kind: "stub",
      target: stringArgument(call, source),
    };
  }
  if (root === "createStubInstance" || root === "stub" || root === "spy") {
    return { expression: text.slice(0, 300), kind: "stub", target: stringArgument(call, source) };
  }
  return null;
}

function isMockInteractionAssertion(text: string, mockNames: string[]): boolean {
  if (!/\bexpect\s*\(/.test(text)) return false;
  if (/\btoHaveBeenCalled|\btoHaveBeenCalledWith|\bcalledOnce|\bcalledWith\b/.test(text)) return true;
  return mockNames.some((name) => name.length > 0 && text.includes(name));
}

function isStateAssertion(text: string): boolean {
  if (!/\bexpect\s*\(/.test(text) && !/\bassert\b/.test(text)) return false;
  return !/\btoHaveBeenCalled|\bcalledOnce\b/.test(text);
}

export function buildMockEverythingEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): MockEverythingEvidence | undefined {
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  if (scope.runner !== "it" && scope.runner !== "test") return undefined;
  const { owner, program, fn } = scope;
  const nested = nestedFunctionRanges(program, candidate);

  const doubles: TestDoubleEvidence[] = [];
  const seen = new Set<number>();
  const doubleRanges = new Map<TestDoubleEvidence, { start: number; end: number }>();
  const factoryRanges = new Map<TestDoubleEvidence, { start: number; end: number }>();
  new Visitor({
    CallExpression(call) {
      const classified = classifyModuleCall(call, owner.source);
      if (!classified || seen.has(call.start)) return;
      seen.add(call.start);
      doubles.push(classified);
      doubleRanges.set(classified, { start: call.start, end: call.end });
      if (classified.kind === "module-mock") {
        factoryRanges.set(classified, { start: call.start, end: call.end });
      }
    },
  }).visit(program);

  if (doubles.length === 0) return undefined;

  const mockTargetNames = doubles
    .map((item) => item.target)
    .filter((target): target is string => target !== null)
    .map((target) => target.split("/").pop()?.replace(/\.[jt]sx?$/, "") ?? target)
    .filter((name) => name.length > 0);

  let mockOnlyAssertions = false;
  const stateAssertions: string[] = [];
  let sawAnyAssertion = false;
  const assertionCalls: { start: number; end: number; text: string }[] = [];
  new Visitor({
    CallExpression(call) {
      if (call.start < fn.start || call.end > fn.end) return;
      if (isInsideNestedFunction(call, nested)) return;
      const text = callText(call, owner.source);
      if (!/\b(expect|assert)\s*[.(]/.test(text)) return;
      assertionCalls.push({ start: call.start, end: call.end, text });
    },
  }).visit(program);
  const outermost = assertionCalls.filter((item) =>
    !assertionCalls.some((other) =>
      other !== item && other.start <= item.start && other.end >= item.end
      && (other.start < item.start || other.end > item.end)
    )
  );
  for (const item of outermost) {
    sawAnyAssertion = true;
    if (isMockInteractionAssertion(item.text, mockTargetNames)) mockOnlyAssertions = true;
    else if (isStateAssertion(item.text)) stateAssertions.push(item.text.slice(0, 300));
  }

  const moduleMocks = doubles.filter((item) => item.kind === "module-mock");
  const insideFactory = (item: TestDoubleEvidence): boolean =>
    moduleMocks.some((factory) =>
      factory !== item
      && factoryRanges.get(factory)?.start !== undefined
      && (factoryRanges.get(factory)?.start ?? 0) <= (doubleRanges.get(item)?.start ?? 0)
      && (factoryRanges.get(factory)?.end ?? 0) >= (doubleRanges.get(item)?.end ?? 0)
    );
  const boundaryOnly = moduleMocks.length <= 1
    && moduleMocks.every((item) =>
      item.target !== null && /clock|date|fetch|network|http|fs|db|random|timer|now/i.test(item.target)
    )
    && doubles.every((item) =>
      item.kind === "module-mock"
      || item.kind === "spy"
      || item.target !== null
      || insideFactory(item)
    );

  return {
    function: {
      title: scope.title,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    doubles: doubles.slice(0, 15),
    mockTargetNames,
    mockOnlyAssertions: sawAnyAssertion && mockOnlyAssertions && stateAssertions.length === 0,
    stateAssertions: stateAssertions.slice(0, 5),
    boundaryOnly,
  };
}
