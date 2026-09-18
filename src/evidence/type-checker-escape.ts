import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression, Program } from "oxc-parser";
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
  moduleImports,
} from "./repository.js";
import type { FunctionCaller, FunctionNode, RelatedProjectModule } from "./repository.js";

type EscapeEvidence = {
  kind: "as-cast" | "angle-assertion" | "non-null" | "suppression";
  expression: string;
  assertedType: string | null;
  castsThroughAny: boolean;
  sourceRoot: string | null;
  sourceKind: "runtime-boundary" | "caller-supplied" | "local";
  flowsIntoCall: string[];
  memberAccessAfterEscape: boolean;
  narrowingGuardNearby: boolean;
};

export type TypeCheckerEscapeEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  escapes: EscapeEvidence[];
  bareAnyAnnotations: string[];
  hasValidatorImport: boolean;
  validatorSource: string | null;
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

const VALIDATOR_SOURCES = new Set(["zod", "io-ts", "yup", "ajv", "valibot", "@sinclair/typebox"]);

const RUNTIME_BOUNDARY_PATTERN = /JSON\.parse|fetch\(|process\.env|localStorage|sessionStorage/;

function parameterNames(fn: FunctionNode): string[] {
  const names: string[] = [];
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    if (value.type === "Identifier") names.push(value.name);
    else if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
      names.push(value.left.name);
    } else if (value.type === "RestElement" && value.argument.type === "Identifier") {
      names.push(value.argument.name);
    }
  }
  return names;
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function lineText(source: string, offset: number): string {
  const line = lineAt(source, offset);
  return source.split("\n")[line - 1]?.trim() ?? "";
}

function flowsIntoCalls(
  escape: NodeRange,
  fn: FunctionNode,
  program: Program,
  source: string,
  nested: NodeRange[],
): string[] {
  const calls: string[] = [];
  new Visitor({
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      if (!containsNode(call, escape) || (call.start === escape.start && call.end === escape.end)) {
        return;
      }
      calls.push(source.slice(call.start, Math.min(call.end, call.start + 300)));
    },
  }).visit(program);
  return calls.slice(0, 5);
}

function memberAccessAfter(
  escape: NodeRange,
  fn: FunctionNode,
  program: Program,
  nested: NodeRange[],
): boolean {
  let found = false;
  new Visitor({
    MemberExpression(node) {
      if (found || !containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (containsNode(node, escape)) found = true;
    },
  }).visit(program);
  return found;
}

function narrowingGuardNearby(
  root: string | null,
  fn: FunctionNode,
  program: Program,
  source: string,
  nested: NodeRange[],
): boolean {
  if (!root) return false;
  let found = false;
  new Visitor({
    IfStatement(node) {
      if (found || !containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const test = source.slice(node.test.start, node.test.end);
      if (test.includes(root) && /typeof|instanceof| in /.test(test)) found = true;
    },
    ConditionalExpression(node) {
      if (found || !containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const test = source.slice(node.test.start, node.test.end);
      if (test.includes(root) && /typeof|instanceof| in /.test(test)) found = true;
    },
  }).visit(program);
  return found;
}

function candidateRoots(inner: Expression): string[] {
  if (inner.type === "ParenthesizedExpression") return candidateRoots(inner.expression);
  if (inner.type === "AwaitExpression") return candidateRoots(inner.argument);
  if (inner.type === "ChainExpression") return candidateRoots(inner.expression);
  if (
    inner.type === "TSAsExpression"
    || inner.type === "TSNonNullExpression"
    || inner.type === "TSSatisfiesExpression"
    || inner.type === "TSTypeAssertion"
  ) return candidateRoots(inner.expression);
  if (inner.type === "Identifier") return [inner.name];
  if (inner.type === "CallExpression") {
    const callee = inner.callee;
    if (callee.type === "Identifier") return [callee.name];
    if (callee.type === "MemberExpression") return candidateRoots(callee.object);
    return [];
  }
  if (inner.type === "MemberExpression") return candidateRoots(inner.object);
  return [];
}

function sourceKind(
  inner: Expression,
  parameters: string[],
  fn: FunctionNode,
  program: Program,
  source: string,
): "runtime-boundary" | "caller-supplied" | "local" {
  const text = source.slice(inner.start, inner.end);
  if (RUNTIME_BOUNDARY_PATTERN.test(text)) return "runtime-boundary";
  const roots = candidateRoots(inner);
  if (roots.some((root) => parameters.includes(root))) return "caller-supplied";
  if (roots.some((root) => initializedFromBoundary(root, fn, program, source))) {
    return "runtime-boundary";
  }
  return "local";
}

function initializedFromBoundary(
  root: string,
  fn: FunctionNode,
  program: Program,
  source: string,
): boolean {
  let found = false;
  new Visitor({
    VariableDeclarator(node) {
      if (found || !containsNode(fn, node)) return;
      if (node.id.type !== "Identifier" || node.id.name !== root || !node.init) return;
      if (RUNTIME_BOUNDARY_PATTERN.test(source.slice(node.init.start, node.init.end))) {
        found = true;
      }
    },
  }).visit(program);
  return found;
}

export function buildTypeCheckerEscapeEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): TypeCheckerEscapeEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const source = ownerFile.source;
  const nested = nestedFunctionRanges(parsed.program, fn);
  const parameters = parameterNames(fn);
  const collected: { start: number; evidence: EscapeEvidence }[] = [];

  const finalize = (
    kind: EscapeEvidence["kind"],
    node: NodeRange,
    inner: Expression | null,
    assertedType: string | null,
  ): void => {
    const root = inner ? candidateRoots(inner)[0] ?? null : null;
    collected.push({
      start: node.start,
      evidence: {
        kind,
        expression: source.slice(node.start, node.end),
        assertedType,
        castsThroughAny: assertedType !== null && /\bany\b/.test(assertedType),
        sourceRoot: root,
        sourceKind: inner ? sourceKind(inner, parameters, fn, parsed.program, source) : "local",
        flowsIntoCall: flowsIntoCalls(node, fn, parsed.program, source, nested),
        memberAccessAfterEscape: memberAccessAfter(node, fn, parsed.program, nested),
        narrowingGuardNearby: narrowingGuardNearby(root, fn, parsed.program, source, nested),
      },
    });
  };

  new Visitor({
    TSAsExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const asserted = source.slice(node.typeAnnotation.start, node.typeAnnotation.end).trim();
      if (asserted === "const") return;
      finalize("as-cast", node, node.expression, asserted);
    },
    TSTypeAssertion(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      finalize(
        "angle-assertion",
        node,
        node.expression,
        source.slice(node.typeAnnotation.start, node.typeAnnotation.end).trim(),
      );
    },
    TSNonNullExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      finalize("non-null", node, node.expression, null);
    },
  }).visit(parsed.program);

  for (const comment of parsed.comments ?? []) {
    if (comment.start < fn.start || comment.end > fn.end) continue;
    if (!/@ts-(expect-error|ignore)/.test(comment.value)) continue;
    const range = { start: comment.start, end: comment.end };
    collected.push({
      start: comment.start,
      evidence: {
        kind: "suppression",
        expression: source.slice(comment.start, comment.end),
        assertedType: null,
        castsThroughAny: false,
        sourceRoot: null,
        sourceKind: "local",
        flowsIntoCall: flowsIntoCalls(range, fn, parsed.program, source, nested),
        memberAccessAfterEscape: false,
        narrowingGuardNearby: false,
      },
    });
  }

  collected.sort((left, right) => left.start - right.start);
  const escapes = collected.map(({ evidence }) => evidence);

  const bareAnyAnnotations: string[] = [];
  new Visitor({
    TSAnyKeyword(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      bareAnyAnnotations.push(`line ${lineAt(source, node.start)}: ${lineText(source, node.start)}`);
    },
  }).visit(parsed.program);

  if (escapes.length === 0) return undefined;

  const imports = moduleImports(parsed.program);
  const validator = imports.find(({ source: from }) => VALIDATOR_SOURCES.has(from));
  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    escapes,
    bareAnyAnnotations,
    hasValidatorImport: validator !== undefined,
    validatorSource: validator?.source ?? null,
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
