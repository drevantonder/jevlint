import { Visitor } from "oxc-parser";
import type { CallExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  calleeRootName,
  isInsideNestedFunction,
  moduleImports,
  nestedFunctionRanges,
  resolveModule,
} from "./repository.js";
import { parseTestFunction } from "./test-scope.js";
import { isTestFileContent } from "./test-signals.js";

export type MirroredExpectation = {
  literal: string;
  inSubject: boolean;
  externalAnchors: string[];
  mirrored: boolean;
};

export type ImplementationMirroredExpectationEvidence = {
  function: {
    title: string | null;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  subject: {
    filePath: string;
    importedFrom: string;
  };
  expectations: MirroredExpectation[];
  mirrored: string[];
};

const INTERACTION_PATTERN = /\btoHaveBeenCalled|\btoHaveBeenNthCalled|\btoHaveBeenCalledTimes|\btoHaveBeenCalledWith|\btoHaveBeenLastCalledWith|\btoHaveBeenFirstCalledWith|\bcalledOnce\b|\bcalledTwice\b|\bcalledThrice\b|\bcalledWith\b|\bsinon\s*\.\s*assert\b/;

const LITERAL_STOPWORDS = new Set([
  "test",
  "tests",
  "describe",
  "expect",
  "assert",
  "true",
  "false",
  "null",
  "undefined",
]);

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

function quotedInner(raw: string): string | null {
  const quote = raw[0];
  if (quote !== "\"" && quote !== "'" && quote !== "`") return null;
  if (raw.length < 2 || raw[raw.length - 1] !== quote) return null;
  if (quote === "`" && raw.includes("${")) return null;
  return raw.slice(1, -1);
}

function literalValue(raw: string): string | null {
  const inner = quotedInner(raw);
  if (inner !== null) {
    if (inner.length < 3 || LITERAL_STOPWORDS.has(inner.toLowerCase())) return null;
    return inner;
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    if (raw === "0" || raw === "1") return null;
    return raw;
  }
  return null;
}

export function buildImplementationMirroredExpectationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ImplementationMirroredExpectationEvidence | undefined {
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  if (scope.runner !== "it" && scope.runner !== "test") return undefined;
  const { owner, program, fn } = scope;
  const nested = nestedFunctionRanges(program, candidate);

  const assertionCalls: { start: number; end: number; text: string }[] = [];
  new Visitor({
    CallExpression(call) {
      if (call.start < fn.start || call.end > fn.end) return;
      if (isInsideNestedFunction(call, nested)) return;
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
  const outcomeAssertions = outermost.filter((item) => !INTERACTION_PATTERN.test(item.text));
  if (outcomeAssertions.length === 0) return undefined;

  const subjects = new Map<string, string>();
  for (const entry of moduleImports(program)) {
    if (!entry.source.startsWith(".")) continue;
    const resolved = resolveModule(owner.filePath, entry.source, projectFiles);
    if (!resolved || resolved.filePath === owner.filePath) continue;
    if (isTestFileContent(resolved.filePath, resolved.source)) continue;
    if (!subjects.has(resolved.filePath)) subjects.set(resolved.filePath, entry.source);
  }
  if (subjects.size === 0) return undefined;

  const literals = new Set<string>();
  new Visitor({
    Literal(node) {
      if (!outcomeAssertions.some((item) => node.start >= item.start && node.end <= item.end)) return;
      if (isInsideNestedFunction(node, nested)) return;
      const value = literalValue(owner.source.slice(node.start, node.end));
      if (value !== null) literals.add(value);
    },
  }).visit(program);
  if (literals.size === 0) return undefined;

  const subjectEntries = [...subjects.entries()];
  const subjectSources = new Map<string, string>();
  for (const [filePath] of subjectEntries) {
    const file = projectFiles.find((item) => item.filePath === filePath);
    if (file) subjectSources.set(filePath, file.source);
  }
  const anchorFiles = projectFiles.filter((file) =>
    file.filePath !== owner.filePath
    && !subjectSources.has(file.filePath)
     && !isTestFileContent(file.filePath, file.source)
  );

  const subject = {
    filePath: subjectEntries[0]?.[0] ?? "",
    importedFrom: subjectEntries[0]?.[1] ?? "",
  };
  const expectations: MirroredExpectation[] = [];
  for (const literal of [...literals].sort()) {
    const inSubject = [...subjectSources.values()].some((source) => source.includes(literal));
    const externalAnchors = anchorFiles
      .filter((file) => file.source.includes(literal))
      .map((file) => file.filePath)
      .slice(0, 5);
    expectations.push({
      literal: literal.slice(0, 200),
      inSubject,
      externalAnchors,
      mirrored: inSubject && externalAnchors.length === 0,
    });
  }

  return {
    function: {
      title: scope.title,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    subject,
    expectations: expectations.slice(0, 15),
    mirrored: expectations.filter((item) => item.mirrored).map((item) => item.literal).slice(0, 10),
  };
}
