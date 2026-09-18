import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type CompiledSourceKind =
  | "literal"
  | "closed-template"
  | "parameter"
  | "request-member"
  | "local"
  | "module-constant"
  | "unknown";

export type CompiledSource = {
  expression: string;
  kind: CompiledSourceKind;
  line: number;
};

export type DynamicSink = {
  sink: "eval" | "Function" | "vm";
  call: string;
  line: number;
  sources: CompiledSource[];
};

export type DynamicCodeExecutionEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    parameters: string[];
  };
  sinks: DynamicSink[];
  dispatchMaps: string[];
  vmImports: string[];
  callers: FunctionCaller[];
};

const VM_METHODS = new Set([
  "runInNewContext",
  "runInContext",
  "runInThisContext",
  "compileFunction",
  "createScript",
  "Script",
]);
const REQUEST_ROOTS = new Set([
  "req",
  "request",
  "res",
  "response",
  "ctx",
  "context",
  "headers",
  "query",
  "body",
  "params",
  "input",
  "args",
  "payload",
  "message",
  "formData",
  "searchParams",
]);

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function namedParameter(parameter: FunctionNode["params"][number]): string | undefined {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "Identifier") return value.name;
  if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
    return value.left.name;
  }
  if (value.type === "RestElement" && value.argument.type === "Identifier") {
    return value.argument.name;
  }
  return undefined;
}

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") return rootIdentifier(expression.object);
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  return undefined;
}

function unwrap(expression: Expression): Expression {
  return expression.type === "ChainExpression" ? expression.expression : expression;
}

function isStringLiteral(expression: Expression, source: string): boolean {
  const node = unwrap(expression);
  if (node.type !== "Literal") return false;
  const raw = source.slice(node.start, node.end);
  return raw.startsWith('"') || raw.startsWith("'");
}

export function buildDynamicCodeExecutionEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DynamicCodeExecutionEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const direct = (node: { start: number; end: number }): boolean =>
    node.start >= candidate.start && node.end <= candidate.end
    && belongsDirectlyToFunction(node, nested);

  const parameters = fn.params.flatMap((parameter) => {
    const parameterName = namedParameter(parameter);
    return parameterName === undefined ? [] : [parameterName];
  });
  const parameterSet = new Set(parameters);

  const moduleConstants = new Set<string>();
  const localInits = new Map<string, Expression>();
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || !node.init) return;
      if (node.start >= candidate.start && node.end <= candidate.end) {
        if (!localInits.has(node.id.name)) localInits.set(node.id.name, node.init);
        return;
      }
      if (isStringLiteral(node.init, owner.source)) moduleConstants.add(node.id.name);
    },
  }).visit(parsed.program);

  const classify = (expression: Expression, hops: number): CompiledSourceKind => {
    const node = unwrap(expression);
    if (node.type === "Literal") return "literal";
    if (node.type === "TemplateLiteral") {
      return node.expressions.length === 0 ? "closed-template" : classifyParts(node.expressions);
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
      return classifyParts([node.left, node.right]);
    }
    if (node.type === "Identifier") {
      if (parameterSet.has(node.name)) return "parameter";
      if (moduleConstants.has(node.name)) return "module-constant";
      if (hops > 0) {
        const init = localInits.get(node.name);
        if (init) return classify(init, hops - 1);
        return "local";
      }
      return "local";
    }
    const root = rootIdentifier(node);
    if (root) {
      if (REQUEST_ROOTS.has(root)) return "request-member";
      if (parameterSet.has(root)) return "parameter";
      if (moduleConstants.has(root)) return "module-constant";
    }
    return "unknown";
  };

  const classifyParts = (parts: readonly Expression[]): CompiledSourceKind => {
    let seenParameter = false;
    for (const part of parts) {
      const kind = classify(part, 0);
      if (kind === "request-member") return "request-member";
      if (kind === "parameter") seenParameter = true;
    }
    return seenParameter ? "parameter" : "unknown";
  };

  const sourceOf = (expression: Expression): CompiledSource => ({
    expression: owner.source.slice(expression.start, expression.end).slice(0, 200),
    kind: classify(expression, 1),
    line: lineAt(owner.source, expression.start),
  });

  const sinks: DynamicSink[] = [];
  const record = (sink: DynamicSink["sink"], start: number, end: number, args: readonly (Expression | { type: "SpreadElement" })[]): void => {
    const compiled = sink === "Function" ? args : args.slice(0, 1);
    sinks.push({
      sink,
      call: owner.source.slice(start, end).slice(0, 500),
      line: lineAt(owner.source, start),
      sources: compiled
        .filter((argument): argument is Expression => argument.type !== "SpreadElement")
        .map(sourceOf)
        .slice(0, 8),
    });
  };

  new Visitor({
    CallExpression(node) {
      if (!direct(node)) return;
      const callee = unwrap(node.callee);
      if (callee.type === "Identifier" && callee.name === "eval") {
        record("eval", node.start, node.end, node.arguments);
        return;
      }
      if (callee.type === "Identifier" && callee.name === "Function") {
        record("Function", node.start, node.end, node.arguments);
        return;
      }
      if (callee.type === "MemberExpression" && callee.object.type === "Identifier" && callee.object.name === "vm") {
        const method = callee.property.type === "Identifier" ? callee.property.name : null;
        if (method && VM_METHODS.has(method)) record("vm", node.start, node.end, node.arguments);
      }
    },
    NewExpression(node) {
      if (!direct(node)) return;
      const callee = unwrap(node.callee);
      if (callee.type === "Identifier" && callee.name === "Function") {
        record("Function", node.start, node.end, node.arguments);
        return;
      }
      if (callee.type === "MemberExpression" && callee.object.type === "Identifier" && callee.object.name === "vm") {
        const method = callee.property.type === "Identifier" ? callee.property.name : null;
        if (method && VM_METHODS.has(method)) record("vm", node.start, node.end, node.arguments);
      }
    },
  }).visit(parsed.program);
  if (sinks.length === 0) return undefined;

  const dispatchMaps: string[] = [];
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || !node.init) return;
      if (node.start >= candidate.start && node.end <= candidate.end) return;
      if (node.init.type !== "ObjectExpression") return;
      const hasFunctionValue = node.init.properties.some((property) =>
        property.type === "Property"
        && (property.value.type === "ArrowFunctionExpression" || property.value.type === "FunctionExpression"),
      );
      if (hasFunctionValue) dispatchMaps.push(node.id.name);
    },
  }).visit(parsed.program);

  const vmImports = moduleImports(parsed.program)
    .map(({ source }) => source)
    .filter((source, index, all) => (source === "vm" || source === "node:vm") && all.indexOf(source) === index);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
      parameters,
    },
    sinks: sinks.slice(0, 10),
    dispatchMaps: dispatchMaps.slice(0, 10),
    vmImports,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
