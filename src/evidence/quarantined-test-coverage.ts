import { Visitor } from "oxc-parser";
import type { CallExpression, Function as OxcFunction, Program } from "oxc-parser";
import type { ArrowFunctionExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  calleeRootName,
  findFunctionCallers,
  isInsideNestedFunction,
  moduleImports,
  nestedFunctionRanges,
  resolveModule,
} from "./repository.js";
import { isTestFilePath, parseTestFunction } from "./test-scope.js";

export type QuarantinedTestCoverageEvidence = {
  function: {
    title: string | null;
    modifier: string;
    filePath: string;
    source: string;
  };
  disabled: {
    assertionCount: number;
    assertions: string[];
    subjectSymbols: string[];
    trackingIssue: string | null;
  };
  coverage: {
    otherTestReferences: string[];
    otherTestReferenceCount: number;
    callers: { filePath: string; call: string; line: number }[];
  };
};

type FunctionNode = OxcFunction | ArrowFunctionExpression;

const SKIP_PATTERN = /\.skip(If|Each|Suite)?\b|\.todo\b|\.xfail\b|^x(test|it)\b|\btest\.todo\b|\bit\.todo\b/;

const TRACKING_PATTERN = /#[0-9]+|https?:\/\/\S+\/(issues|pull)\/\d+|TODO|FIXME/i;

function holderModifier(program: Program, fn: FunctionNode, source: string): string | null {
  let modifier: string | null = null;
  new Visitor({
    CallExpression(call) {
      if (modifier) return;
      if (call.start > fn.start || call.end < fn.end) return;
      const holds = call.arguments.some((argument) => {
        if (argument.type === "SpreadElement") return false;
        const value = argument.type === "ChainExpression" ? argument.expression : argument;
        return (
          (value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression")
          && value.start === fn.start
          && value.end === fn.end
        );
      });
      if (!holds) return;
      const text = source.slice(call.callee.start, call.callee.end);
      if (SKIP_PATTERN.test(text)) modifier = text.slice(0, 120);
    },
  }).visit(program);
  return modifier;
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

export function buildQuarantinedTestCoverageEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): QuarantinedTestCoverageEvidence | undefined {
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  const { owner, program, fn } = scope;

  const modifier = holderModifier(program, fn, owner.source);
  if (!modifier) return undefined;

  const nested = nestedFunctionRanges(program, candidate);
  const assertionCalls: { start: number; end: number; text: string }[] = [];
  new Visitor({
    CallExpression(call) {
      if (call.start < fn.start || call.end > fn.end) return;
      if (isInsideNestedFunction(call, nested)) return;
      if (!isAssertionCall(call)) return;
      assertionCalls.push({
        start: call.start,
        end: call.end,
        text: owner.source.slice(call.start, call.end).slice(0, 300),
      });
    },
  }).visit(program);
  const assertions = assertionCalls
    .filter((item) =>
      !assertionCalls.some((other) =>
        other !== item && other.start <= item.start && other.end >= item.end
        && (other.start < item.start || other.end > item.end)
      )
    )
    .map(({ text }) => text)
    .slice(0, 10);

  const body = owner.source.slice(fn.start, fn.end);
  const imports = moduleImports(program);
  const subjectSymbols = imports
    .filter(({ source }) => source.startsWith("."))
    .map(({ local }) => local)
    .filter((local) => local !== "describe" && new RegExp(`\\b${local.replace(/\$/g, "\\$")}\\b`).test(body))
    .filter((local, index, all) => all.indexOf(local) === index)
    .slice(0, 10);

  const otherTestReferences: string[] = [];
  let otherTestReferenceCount = 0;
  const titleWords = (scope.title ?? "").split(/\s+/).filter((word) => word.length > 3);
  for (const file of projectFiles) {
    if (file.filePath === owner.filePath) continue;
    if (!isTestFilePath(file.filePath)) continue;
    const namesSubject = subjectSymbols.some((symbol) =>
      new RegExp(`\\b${symbol.replace(/\$/g, "\\$")}\\b`).test(file.source)
    );
    const namesTitle = titleWords.some((word) => file.source.includes(word));
    if (!namesSubject && !namesTitle) continue;
    otherTestReferenceCount += 1;
    if (otherTestReferences.length < 10) otherTestReferences.push(file.filePath);
  }

  const callers = subjectSymbols.flatMap((symbol) =>
    findFunctionCallers(
      resolveModule(owner.filePath, imports.find(({ local }) => local === symbol)?.source ?? "", projectFiles)?.filePath
        ?? owner.filePath,
      symbol,
      projectFiles,
    )
  ).slice(0, 10);

  const trackingMatch = TRACKING_PATTERN.exec(`${scope.title ?? ""}\n${body.slice(0, 2000)}`);

  return {
    function: {
      title: scope.title,
      modifier,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    disabled: {
      assertionCount: assertions.length,
      assertions,
      subjectSymbols,
      trackingIssue: trackingMatch?.[0].slice(0, 120) ?? null,
    },
    coverage: {
      otherTestReferences,
      otherTestReferenceCount,
      callers,
    },
  };
}
