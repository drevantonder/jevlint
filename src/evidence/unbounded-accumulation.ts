import { parseSync, Visitor } from "oxc-parser";
import type { Expression, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode, nestedFunctionRanges } from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller, RelatedProjectModule } from "./repository.js";

export type UnboundedAccumulationEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  containers: Array<{
    name: string;
    kind: "array" | "map" | "set" | "object";
    lifetime: "module" | "closure";
  }>;
  growths: Array<{
    container: string;
    method: string;
    source: string;
  }>;
  eviction: {
    hasDelete: boolean;
    hasClear: boolean;
    hasTtlOrLru: boolean;
    hasLengthGuard: boolean;
    evictionImports: string[];
  };
  inputKeyed: boolean;
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootIdentifier(expression.object);
  }
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  return undefined;
}

function containerKind(
  init: NonNullable<import("oxc-parser").VariableDeclarator["init"]>,
): "array" | "map" | "set" | "object" | undefined {
  if (init.type === "ArrayExpression") return "array";
  if (init.type === "ObjectExpression") return "object";
  if (init.type === "NewExpression") {
    const callee = init.callee;
    const name = callee.type === "Identifier" ? callee.name : undefined;
    if (name === "Map") return "map";
    if (name === "Set") return "set";
    if (name === "Array") return "array";
  }
  return undefined;
}

function parameterNames(fn: ReturnType<typeof findDirectFunction>, source: string): string[] {
  if (!fn) return [];
  const names: string[] = [];
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    const text = source.slice(value.start, value.end);
    const match = /^[A-Za-z_$][\w$]*/.exec(text);
    if (match?.[0]) names.push(match[0]);
  }
  return names;
}

export function buildUnboundedAccumulationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnboundedAccumulationEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseSync(ownerFile.filePath, ownerFile.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const nested = nestedFunctionRanges(parsed.program, fn);

  const containers = new Map<string, { kind: "array" | "map" | "set" | "object"; lifetime: "module" | "closure" }>();
  const moduleBindings = new Set<string>();
  for (const statement of parsed.program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const item of declaration.declarations) {
      if (item.id.type === "Identifier") moduleBindings.add(item.id.name);
    }
  }
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || !node.init) return;
      const kind = containerKind(node.init);
      if (!kind) return;
      if (containsNode(fn, node)) return;
      containers.set(
        node.id.name,
        { kind, lifetime: moduleBindings.has(node.id.name) ? "module" : "closure" },
      );
    },
  }).visit(parsed.program);
  if (containers.size === 0) return undefined;

  const growths: Array<{ container: string; method: string; source: string }> = [];
  new Visitor({
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      if (call.callee.type !== "MemberExpression") return;
      const property = call.callee.property.type === "Identifier"
        ? call.callee.property.name
        : call.callee.property.type === "Literal"
          ? String(call.callee.property.value)
          : undefined;
      if (property !== "push" && property !== "set" && property !== "add") return;
      const root = rootIdentifier(call.callee);
      if (!root || !containers.has(root)) return;
      growths.push({ container: root, method: property, source: nodeSource(call, ownerFile.source) });
    },
  }).visit(parsed.program);
  if (growths.length === 0) return undefined;

  const grown = new Set(growths.map(({ container }) => container));
  let hasDelete = false;
  let hasClear = false;
  let hasTtlOrLru = false;
  let hasLengthGuard = false;
  new Visitor({
    CallExpression(call) {
      if (call.callee.type !== "MemberExpression") return;
      const property = call.callee.property.type === "Identifier" ? call.callee.property.name : undefined;
      const root = rootIdentifier(call.callee);
      if (!root || !grown.has(root)) return;
      if (property === "delete") hasDelete = true;
      if (property === "clear") hasClear = true;
    },
    UnaryExpression(node) {
      if (node.operator !== "delete") return;
      const root = node.argument.type === "MemberExpression" ? rootIdentifier(node.argument) : undefined;
      if (root && grown.has(root)) hasDelete = true;
    },
    Identifier(node) {
      if (/^(?:ttl|TTL|TTLDuration|maxAge|lru|LRU|evict|expire)$/i.test(node.name)) hasTtlOrLru = true;
    },
    IfStatement(node) {
      const text = nodeSource(node.test, ownerFile.source);
      if ([...grown].some((name) => text.includes(`${name}.length`) || text.includes(`${name}.size`))) {
        hasLengthGuard = true;
      }
    },
  }).visit(parsed.program);

  const imports = moduleImports(parsed.program);
  const evictionImports = imports
    .filter(({ source }) => /lru|ttl|cache|evict|expir/i.test(source))
    .map(({ source }) => source);
  if (evictionImports.length > 0) hasTtlOrLru = true;

  if (hasDelete || hasClear || hasTtlOrLru || hasLengthGuard) return undefined;

  const parameters = new Set(parameterNames(fn, ownerFile.source));
  let inputKeyed = false;
  const growthRanges: NodeRange[] = [];
  new Visitor({
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      if (growths.some(({ source }) => source === nodeSource(call, ownerFile.source))) {
        growthRanges.push(call);
      }
    },
    Identifier(node) {
      if (inputKeyed) return;
      if (!growthRanges.some((range) => containsNode(range, node))) return;
      if (parameters.has(node.name)) inputKeyed = true;
      if (/^(?:req|request|body|params|query|url|input|event)$/i.test(node.name)) inputKeyed = true;
    },
  }).visit(parsed.program);

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    containers: [...containers]
      .filter(([containerName]) => grown.has(containerName))
      .map(([containerName, info]) => ({ name: containerName, ...info })),
    growths,
    eviction: {
      hasDelete,
      hasClear,
      hasTtlOrLru,
      hasLengthGuard,
      evictionImports,
    },
    inputKeyed,
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(candidate.filePath, parsed.program, projectFiles),
    },
  };
}
