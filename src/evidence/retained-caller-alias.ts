import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type {
  Argument,
  ArrayExpressionElement,
  AssignmentTarget,
  BindingPattern,
  Class,
  Expression,
  ObjectPropertyKind,
  Program,
  TSType,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionNode } from "./repository.js";

const MAX_RETENTIONS = 10;
const MAX_COPIES = 10;
const MAX_OPERATION_CHARS = 200;

// Storing through these receivers keeps the value reachable after the call
// returns. Delivery-shaped methods (emit, publish, send, dispatch) and
// removal-shaped methods (delete, remove, clear) are deliberately absent:
// they hand the value on or drop it rather than retain it.
const RETAINING_METHODS = new Set([
  "add",
  "append",
  "cache",
  "insert",
  "put",
  "push",
  "register",
  "save",
  "set",
  "store",
  "unshift",
]);

const COPY_CONSTRUCTORS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);

export type RetentionKind = "this-field" | "outer-scope" | "cache-store";

export type RetainedAlias = {
  parameter: string;
  kind: RetentionKind;
  target: string;
  operation: string;
  via: "reference" | "member";
};

export type RetainedCopy = {
  parameter: string;
  operation: string;
};

export type RetainedCallerAliasEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    parameters: string[];
  };
  retentions: RetainedAlias[];
  copies: RetainedCopy[];
};

type SourceRange = {
  start: number;
  end: number;
};

function compact(source: string, node: SourceRange): string {
  return source.slice(node.start, node.end).replaceAll(/\s+/g, " ").slice(0, MAX_OPERATION_CHARS);
}

function annotationIsPrimitive(annotation: TSType | null | undefined): boolean {
  if (!annotation) return false;
  switch (annotation.type) {
    case "TSStringKeyword":
    case "TSNumberKeyword":
    case "TSBooleanKeyword":
    case "TSBigIntKeyword":
    case "TSSymbolKeyword":
    case "TSVoidKeyword":
    case "TSNeverKeyword":
    case "TSNullKeyword":
    case "TSUndefinedKeyword":
    case "TSLiteralType":
      return true;
    case "TSUnionType":
      return annotation.types.every(annotationIsPrimitive);
    default:
      return false;
  }
}

function patternAnnotation(pattern: BindingPattern): TSType | null | undefined {
  return pattern.typeAnnotation?.typeAnnotation;
}

// A rest binding collects a fresh array the caller cannot reach, so storing
// it shares nothing: rest-sourced names land in `fresh`, never in `sources`.
function collectPatternNames(pattern: BindingPattern, names: string[], fresh: string[]): void {
  switch (pattern.type) {
    case "Identifier":
      names.push(pattern.name);
      return;
    case "AssignmentPattern":
      collectPatternNames(pattern.left, names, fresh);
      return;
    case "ArrayPattern":
      for (const element of pattern.elements) {
        if (!element) continue;
        if (element.type === "RestElement") {
          const before = names.length;
          collectPatternNames(element.argument, names, fresh);
          fresh.push(...names.splice(before));
        } else {
          collectPatternNames(element, names, fresh);
        }
      }
      return;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        if (property.type === "RestElement") {
          const before = names.length;
          collectPatternNames(property.argument, names, fresh);
          fresh.push(...names.splice(before));
        } else {
          collectPatternNames(property.value, names, fresh);
        }
      }
      return;
  }
}

function methodName(program: Program, fn: FunctionNode): string | undefined {
  let result: string | undefined;
  new Visitor({
    MethodDefinition(node) {
      if (!result && node.value === fn && node.key.type === "Identifier") {
        result = node.key.name;
      }
    },
  }).visit(program);
  return result;
}

function enclosingClass(program: Program, fn: FunctionNode): Class | undefined {
  let result: Class | undefined;
  new Visitor({
    ClassDeclaration(node) {
      if (node.start > fn.start || node.end < fn.end) return;
      if (!result || (node.start >= result.start && node.end <= result.end)) result = node;
    },
    ClassExpression(node) {
      if (node.start > fn.start || node.end < fn.end) return;
      if (!result || (node.start >= result.start && node.end <= result.end)) result = node;
    },
  }).visit(program);
  return result;
}

function isClassExported(program: Program, classNode: Class): boolean {
  const name = classNode.id?.name;
  for (const statement of program.body) {
    if (statement.type === "ExportDefaultDeclaration" && statement.declaration === classNode) {
      return true;
    }
    if (statement.type !== "ExportNamedDeclaration") continue;
    if (statement.declaration === classNode) return true;
    if (
      name !== undefined
      && statement.specifiers.some((specifier) =>
        specifier.local.type === "Identifier" && specifier.local.name === name
      )
    ) return true;
  }
  return false;
}

// Root binding of an expression path: "this" for this-anchored paths, the
// leading identifier otherwise, undefined for computed shapes we cannot name.
function rootName(expression: Expression): string | undefined {
  switch (expression.type) {
    case "Identifier":
      return expression.name;
    case "ThisExpression":
      return "this";
    case "Super":
      return undefined;
    case "MemberExpression":
      if (expression.object.type === "Super") return undefined;
      return rootName(expression.object);
    case "ChainExpression":
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
    case "TSTypeAssertion":
      return rootName(expression.expression);
    default:
      return undefined;
  }
}

type ValueClass =
  | { kind: "alias"; parameter: string; via: "reference" | "member" }
  | { kind: "copy"; parameter: string };

function copyOfSpread(
  elements: Array<ArrayExpressionElement | ObjectPropertyKind>,
  sources: Map<string, string>,
): string | undefined {
  for (const element of elements) {
    if (!element || element.type !== "SpreadElement") continue;
    const root = rootName(element.argument);
    if (root && sources.has(root)) return root;
  }
  return undefined;
}

function firstSourceArgument(args: Argument[], sources: Map<string, string>): string | undefined {
  for (const arg of args) {
    if (arg.type === "SpreadElement") continue;
    const root = rootName(arg);
    if (root && sources.has(root)) return root;
  }
  return undefined;
}

function isFreshTarget(expression: Expression): boolean {
  return expression.type === "ObjectExpression"
    || expression.type === "ArrayExpression"
    || expression.type === "NewExpression";
}

// Classify the stored value: a caller alias (bare parameter or a member of
// one, through wrappers and fallback branches), a visible copy of one, or an
// unmodeled shape we structurally abstain on.
function classifyValue(expression: Expression, sources: Map<string, string>): ValueClass | undefined {
  switch (expression.type) {
    case "Identifier":
      return sources.has(expression.name)
        ? { kind: "alias", parameter: expression.name, via: "reference" }
        : undefined;
    case "MemberExpression": {
      const root = rootName(expression.object);
      if (!root || !sources.has(root)) return undefined;
      return { kind: "alias", parameter: root, via: "member" };
    }
    case "TSAsExpression":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
    case "TSTypeAssertion":
    case "ParenthesizedExpression":
    case "ChainExpression":
      return classifyValue(expression.expression, sources);
    case "LogicalExpression": {
      const left = classifyValue(expression.left, sources);
      if (left?.kind === "alias") return left;
      const right = classifyValue(expression.right, sources);
      if (right?.kind === "alias") return right;
      return left ?? right;
    }
    case "ConditionalExpression": {
      const consequent = classifyValue(expression.consequent, sources);
      if (consequent?.kind === "alias") return consequent;
      const alternate = classifyValue(expression.alternate, sources);
      if (alternate?.kind === "alias") return alternate;
      return consequent ?? alternate;
    }
    case "ArrayExpression": {
      const parameter = copyOfSpread(expression.elements, sources);
      return parameter ? { kind: "copy", parameter } : undefined;
    }
    case "ObjectExpression": {
      const parameter = copyOfSpread(expression.properties, sources);
      return parameter ? { kind: "copy", parameter } : undefined;
    }
    case "CallExpression": {
      const callee = expression.callee;
      if (callee.type === "MemberExpression") {
        if (callee.property.type === "Identifier" && callee.property.name === "slice") {
          const root = rootName(callee.object);
          if (root && sources.has(root)) return { kind: "copy", parameter: root };
          return undefined;
        }
        if (
          callee.object.type === "Identifier"
          && callee.object.name === "Array"
          && callee.property.type === "Identifier"
          && callee.property.name === "from"
        ) {
          const parameter = firstSourceArgument(expression.arguments, sources);
          return parameter ? { kind: "copy", parameter } : undefined;
        }
        if (
          callee.object.type === "Identifier"
          && callee.object.name === "Object"
          && callee.property.type === "Identifier"
          && callee.property.name === "assign"
          && expression.arguments.length >= 2
        ) {
          const [target, ...rest] = expression.arguments;
          if (target && target.type !== "SpreadElement" && isFreshTarget(target)) {
            const parameter = firstSourceArgument(rest, sources);
            return parameter ? { kind: "copy", parameter } : undefined;
          }
          return undefined;
        }
        if (
          callee.object.type === "Identifier"
          && callee.object.name === "JSON"
          && callee.property.type === "Identifier"
          && callee.property.name === "parse"
          && expression.arguments.length === 1
        ) {
          const [arg] = expression.arguments;
          if (
            arg
            && arg.type === "CallExpression"
            && arg.callee.type === "MemberExpression"
            && arg.callee.object.type === "Identifier"
            && arg.callee.object.name === "JSON"
            && arg.callee.property.type === "Identifier"
            && arg.callee.property.name === "stringify"
          ) {
            const parameter = firstSourceArgument(arg.arguments, sources);
            return parameter ? { kind: "copy", parameter } : undefined;
          }
          return undefined;
        }
        return undefined;
      }
      if (callee.type === "Identifier" && callee.name === "structuredClone") {
        const parameter = firstSourceArgument(expression.arguments, sources);
        return parameter ? { kind: "copy", parameter } : undefined;
      }
      return undefined;
    }
    case "NewExpression": {
      if (
        expression.callee.type === "Identifier"
        && COPY_CONSTRUCTORS.has(expression.callee.name)
        && expression.arguments.length >= 1
      ) {
        const parameter = firstSourceArgument(expression.arguments, sources);
        return parameter ? { kind: "copy", parameter } : undefined;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

type Storage = { kind: RetentionKind; target: string };

function patternStorage(
  pattern: AssignmentTarget,
  source: string,
  isLocal: (name: string) => boolean,
): Storage | undefined {
  const found: Storage[] = [];
  const visit = (target: AssignmentTarget | { type: "AssignmentPattern"; left: AssignmentTarget }): void => {
    if (target.type === "AssignmentPattern") {
      visit(target.left);
      return;
    }
    if (target.type === "Identifier") {
      if (!isLocal(target.name)) found.push({ kind: "outer-scope", target: target.name });
      return;
    }
    if (target.type === "MemberExpression") {
      const storage = memberStorage(target, source, isLocal);
      if (storage) found.push(storage);
      return;
    }
    if (target.type === "ArrayPattern") {
      for (const element of target.elements) {
        if (!element) continue;
        if (element.type === "RestElement") visit(element.argument);
        else if (element.type === "AssignmentPattern") visit(element.left);
        else visit(element);
      }
      return;
    }
    if (target.type === "ObjectPattern") {
      for (const property of target.properties) {
        if (property.type === "RestElement") visit(property.argument);
        else visit(property.value);
      }
    }
  };
  visit(pattern);
  return found.find((entry) => entry.kind === "this-field") ?? found[0];
}

function memberStorage(
  target: { object: Expression; start: number; end: number },
  source: string,
  isLocal: (name: string) => boolean,
): Storage | undefined {
  const root = rootName(target.object);
  if (!root) return undefined;
  if (root === "this") return { kind: "this-field", target: source.slice(target.start, target.end) };
  if (isLocal(root)) return undefined;
  return { kind: "outer-scope", target: source.slice(target.start, target.end) };
}

function assignmentStorage(
  target: AssignmentTarget,
  source: string,
  isLocal: (name: string) => boolean,
): Storage | undefined {
  switch (target.type) {
    case "Identifier":
      return isLocal(target.name) ? undefined : { kind: "outer-scope", target: target.name };
    case "MemberExpression":
      return memberStorage(target, source, isLocal);
    case "ArrayPattern":
    case "ObjectPattern":
      return patternStorage(target, source, isLocal);
    default:
      return undefined;
  }
}

export function buildRetainedCallerAliasEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): RetainedCallerAliasEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn) ?? methodName(parsed.program, fn);
  if (!name) return undefined;

  const sources = new Map<string, string>();
  const displays: string[] = [];
  for (const param of fn.params) {
    if (param.type === "RestElement") continue;
    const inner: BindingPattern = param.type === "TSParameterProperty" ? param.parameter : param;
    if (annotationIsPrimitive(patternAnnotation(inner))) continue;
    const names: string[] = [];
    const fresh: string[] = [];
    collectPatternNames(inner, names, fresh);
    const display = owner.source.slice(param.start, param.end);
    for (const binding of names) {
      if (!fresh.includes(binding) && !sources.has(binding)) sources.set(binding, display);
    }
    displays.push(display);
  }
  if (sources.size === 0) return undefined;

  const locals = new Set<string>(sources.keys());
  const nested = nestedFunctionRanges(parsed.program, candidate);
  const inScope = (node: SourceRange): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !nested.some((range) => range.start <= node.start && range.end >= node.end);
  const isLocal = (binding: string): boolean => locals.has(binding);

  new Visitor({
    VariableDeclarator(node) {
      if (!inScope(node)) return;
      const names: string[] = [];
      if (node.id.type === "Identifier") names.push(node.id.name);
      else if (node.id.type === "ArrayPattern" || node.id.type === "ObjectPattern") {
        collectPatternNames(node.id, names, []);
      } else if (node.id.type === "AssignmentPattern") {
        collectPatternNames(node.id.left, names, []);
      }
      for (const binding of names) locals.add(binding);
    },
    FunctionDeclaration(node) {
      if (node.id && inScope(node)) locals.add(node.id.name);
    },
    ClassDeclaration(node) {
      if (node.id && inScope(node)) locals.add(node.id.name);
    },
  }).visit(parsed.program);

  const retentions: Array<RetainedAlias & SourceRange> = [];
  const copies: RetainedCopy[] = [];

  new Visitor({
    AssignmentExpression(node) {
      if (node.operator !== "=" || !inScope(node)) return;
      const storage = assignmentStorage(node.left, owner.source, isLocal);
      if (!storage) return;
      const value = classifyValue(node.right, sources);
      if (!value) return;
      if (value.kind === "alias") {
        if (retentions.length >= MAX_RETENTIONS) return;
        retentions.push({
          parameter: value.parameter,
          kind: storage.kind,
          target: storage.target,
          operation: compact(owner.source, node),
          via: value.via,
          start: node.start,
          end: node.end,
        });
      } else if (copies.length < MAX_COPIES) {
        copies.push({ parameter: value.parameter, operation: compact(owner.source, node) });
      }
    },
    CallExpression(node) {
      if (!inScope(node) || node.callee.type !== "MemberExpression") return;
      if (node.callee.property.type !== "Identifier") return;
      const method = node.callee.property.name;
      if (!RETAINING_METHODS.has(method)) return;
      const receiver = rootName(node.callee.object);
      if (!receiver || (receiver !== "this" && isLocal(receiver))) return;
      // Only the stored payload position counts: the last argument for
      // keyed stores (set, put, register), the single argument for plain
      // stores (add, push). A caller-derived key with a copied value is a
      // safe store, and key-position aliases are out of scope.
      const payload = node.arguments.length === 1
        ? node.arguments[0]
        : node.arguments[node.arguments.length - 1];
      if (!payload || payload.type === "SpreadElement") return;
      const value = classifyValue(payload, sources);
      if (!value) return;
      if (value.kind === "alias") {
        if (retentions.length >= MAX_RETENTIONS) return;
        retentions.push({
          parameter: value.parameter,
          kind: "cache-store",
          target: `${compact(owner.source, node.callee.object)}.${method}`,
          operation: compact(owner.source, node),
          via: value.via,
          start: node.start,
          end: node.end,
        });
      } else if (copies.length < MAX_COPIES) {
        copies.push({ parameter: value.parameter, operation: compact(owner.source, node) });
      }
    },
  }).visit(parsed.program);

  if (retentions.length === 0) return undefined;
  retentions.sort((left, right) => left.start - right.start);

  const enclosing = enclosingClass(parsed.program, fn);
  const exported = enclosing
    ? isClassExported(parsed.program, enclosing)
    : isFunctionExported(parsed.program, fn, name);

  return {
    function: {
      name,
      exported,
      filePath: owner.filePath,
      source: candidate.source,
      parameters: displays,
    },
    retentions: retentions.map(({ parameter, kind, target, operation, via }) => ({
      parameter,
      kind,
      target,
      operation,
      via,
    })),
    copies: copies.slice(0, MAX_COPIES),
  };
}
