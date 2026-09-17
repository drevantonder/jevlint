import { Visitor } from "oxc-parser";
import type { CallExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  calleeRootName,
  findModuleImporters,
  isInsideNestedFunction,
  moduleImports,
  nestedFunctionRanges,
  resolveModule,
} from "./repository.js";
import { parseTestFunction } from "./test-scope.js";

export type IncidentalSnapshotEvidence = {
  function: {
    title: string | null;
    filePath: string;
    source: string;
  };
  snapshots: {
    assertion: string;
    snapshottedExpression: string;
    snapshottedWidth: number;
    inlineLiteralWidth: number | null;
  }[];
  outcomeAssertionCount: number;
  outcomeAssertions: string[];
  subject: {
    importedSymbols: string[];
    importers: { filePath: string; importedSymbols: string[] }[];
  };
};

const SNAPSHOT_PATTERN = /\btoMatchSnapshot\b|\btoMatchInlineSnapshot\b/;

function callText(call: CallExpression, source: string): string {
  return source.slice(call.start, call.end);
}

function propertyName(call: CallExpression): string | null {
  const callee = call.callee;
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  if (
    callee.type === "ChainExpression"
    && callee.expression.type === "MemberExpression"
    && callee.expression.property.type === "Identifier"
  ) return callee.expression.property.name;
  return null;
}

function isAssertionCall(call: CallExpression): boolean {
  const root = calleeRootName(call.callee);
  if (root === "expect" || root === "assert") return true;
  const property = propertyName(call);
  return property !== null && /^to[A-Z]/.test(property);
}

function receiverText(call: CallExpression, source: string): string {
  const callee = call.callee;
  const object = callee.type === "MemberExpression" ? callee.object : null;
  if (!object) return "";
  return source.slice(object.start, object.end).slice(0, 500);
}

function inlineLiteralWidth(call: CallExpression, source: string): number | null {
  const inline = call.arguments.find((argument) => argument.type !== "SpreadElement");
  if (!inline) return null;
  if (inline.type === "Literal" || inline.type === "TemplateLiteral") {
    return source.slice(inline.start, inline.end).length;
  }
  return null;
}

export function buildIncidentalSnapshotEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): IncidentalSnapshotEvidence | undefined {
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  if (scope.runner !== "it" && scope.runner !== "test") return undefined;
  const { owner, program, fn } = scope;
  const nested = nestedFunctionRanges(program, candidate);

  const assertionCalls: CallExpression[] = [];
  new Visitor({
    CallExpression(call) {
      if (call.start < fn.start || call.end > fn.end) return;
      if (isInsideNestedFunction(call, nested)) return;
      if (!isAssertionCall(call)) return;
      assertionCalls.push(call);
    },
  }).visit(program);

  const outermost = assertionCalls.filter((item) =>
    !assertionCalls.some((other) =>
      other !== item && other.start <= item.start && other.end >= item.end
      && (other.start < item.start || other.end > item.end)
    )
  );
  const snapshotCalls = outermost.filter((call) => SNAPSHOT_PATTERN.test(callText(call, owner.source)));
  const outcomeAssertions = outermost
    .filter((call) => !SNAPSHOT_PATTERN.test(callText(call, owner.source)))
    .map((call) => callText(call, owner.source).slice(0, 300));

  if (snapshotCalls.length === 0) return undefined;

  const imports = moduleImports(program);
  const relativeImports = imports.filter(({ source }) => source.startsWith("."));
  const firstRelative = relativeImports[0];
  const subjectFile = firstRelative
    ? resolveModule(owner.filePath, firstRelative.source, projectFiles)
    : undefined;
  const subjectSymbols = subjectFile
    ? relativeImports
      .filter(({ source }) => resolveModule(owner.filePath, source, projectFiles)?.filePath === subjectFile.filePath)
      .map(({ local }) => local)
      .filter((local, index, all) => all.indexOf(local) === index)
      .slice(0, 10)
    : [];
  const importers = subjectFile ? findModuleImporters(subjectFile.filePath, projectFiles) : [];

  return {
    function: {
      title: scope.title,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    snapshots: snapshotCalls.slice(0, 10).map((call) => {
      const receiver = receiverText(call, owner.source);
      return {
        assertion: callText(call, owner.source).slice(0, 500),
        snapshottedExpression: receiver,
        snapshottedWidth: receiver.length,
        inlineLiteralWidth: inlineLiteralWidth(call, owner.source),
      };
    }),
    outcomeAssertionCount: outcomeAssertions.length,
    outcomeAssertions: outcomeAssertions.slice(0, 10),
    subject: {
      importedSymbols: subjectSymbols,
      importers: importers
        .filter(({ filePath }) => filePath !== owner.filePath)
        .slice(0, 10)
        .map(({ filePath, importedSymbols }) => ({ filePath, importedSymbols })),
    },
  };
}
