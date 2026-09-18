import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Node, Program } from "oxc-parser";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";
import type { Candidate, ProjectFile } from "../types.js";

const MAX_SIBLINGS = 6;
const MAX_CALLERS_PER_FUNCTION = 4;

export type ErrorReportingStyle =
  | "throw"
  | "return-null"
  | "return-undefined"
  | "return-envelope"
  | "return-sentinel";

type ModuleFunction = {
  name: string;
  node: FunctionNode;
  exported: boolean;
};

export type SiblingErrorContract = {
  name: string;
  exported: boolean;
  reportingStyles: ErrorReportingStyle[];
  returnAnnotation: string | null;
  excerpt: string;
  callers: FunctionCaller[];
};

export type InconsistentErrorContractEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    reportingStyles: ErrorReportingStyle[];
    returnAnnotation: string | null;
  };
  siblings: SiblingErrorContract[];
  sharedContract: {
    hasSharedResultType: boolean;
    detail: string | null;
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function moduleFunctions(program: Program): ModuleFunction[] {
  const functions: ModuleFunction[] = [];
  for (const statement of program.body) {
    const exported = statement.type === "ExportNamedDeclaration";
    const declaration = exported ? statement.declaration : statement;
    if (declaration?.type === "FunctionDeclaration") {
      const name = declaration.id?.name;
      if (name) functions.push({ name, node: declaration, exported });
      continue;
    }
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const item of declaration.declarations) {
      if (item.id.type !== "Identifier" || !item.init) continue;
      if (
        item.init.type === "ArrowFunctionExpression"
        || item.init.type === "FunctionExpression"
      ) functions.push({ name: item.id.name, node: item.init, exported });
    }
  }
  return functions;
}

function isEnvelopeReturn(source: string): boolean {
  return /\{\s*(ok|success|error)\s*:/.test(source);
}

function isSentinelReturn(source: string): boolean {
  const text = source.trim();
  return text === "-1" || text === '""' || text === "''" || text === "false" || text === "0";
}

function reportingStylesFor(
  fn: FunctionNode,
  program: Program,
  source: string,
): ErrorReportingStyle[] {
  const nested = nestedFunctionRanges(program, fn);
  const styles = new Set<ErrorReportingStyle>();
  new Visitor({
    ThrowStatement(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      styles.add("throw");
    },
    ReturnStatement(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (!node.argument) return;
      const text = nodeSource(node.argument, source).trim();
      if (text === "null") styles.add("return-null");
      else if (text === "undefined") styles.add("return-undefined");
      else if (isEnvelopeReturn(text)) styles.add("return-envelope");
      else if (isSentinelReturn(text)) styles.add("return-sentinel");
    },
  }).visit(program);
  return [...styles];
}

function returnAnnotation(fn: FunctionNode, source: string): string | null {
  const paramsEnd = fn.params.length > 0 ? fn.params[fn.params.length - 1]?.end : undefined;
  const bodyStart = fn.body?.start;
  if (paramsEnd === undefined || bodyStart === undefined) return null;
  const between = source.slice(paramsEnd, bodyStart);
  const match = /\)\s*:\s*(.+?)\s*(?:=>)?$/.exec(between.trim());
  return match?.[1]?.trim() ?? null;
}

function sharedResultType(source: string): string | null {
  const match = /(?:type|interface)\s+(\w*(?:Result|Outcome|Maybe)\w*)\s*[=<{]/.exec(source);
  if (match?.[1]) return `shared contract type ${match[1]}`;
  if (/Result\s*</.test(source)) return "shared generic Result type in module";
  return null;
}

export function buildInconsistentErrorContractEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): InconsistentErrorContractEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const candidateStyles = reportingStylesFor(fn, parsed.program, owner.source);
  if (candidateStyles.length === 0) return undefined;

  const siblings: SiblingErrorContract[] = [];
  for (const other of moduleFunctions(parsed.program)) {
    if (other.name === name) continue;
    if (siblings.length >= MAX_SIBLINGS) break;
    const styles = reportingStylesFor(other.node, parsed.program, owner.source);
    if (styles.length === 0) continue;
    const disjoint = styles.some((style) => !candidateStyles.includes(style));
    if (!disjoint) continue;
    siblings.push({
      name: other.name,
      exported: other.exported,
      reportingStyles: styles,
      returnAnnotation: returnAnnotation(other.node, owner.source),
      excerpt: owner.source.slice(other.node.start, other.node.end).slice(0, 800),
      callers: findFunctionCallers(candidate.filePath, other.name, projectFiles)
        .slice(0, MAX_CALLERS_PER_FUNCTION),
    });
  }
  if (siblings.length === 0) return undefined;

  const shared = sharedResultType(owner.source);
  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
      reportingStyles: candidateStyles,
      returnAnnotation: returnAnnotation(fn, owner.source),
    },
    siblings,
    sharedContract: {
      hasSharedResultType: shared !== null,
      detail: shared,
    },
  };
}
