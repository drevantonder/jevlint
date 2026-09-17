import { parseSync, Visitor } from "oxc-parser";
import type { Expression, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type PartialNarrowing = {
  binding: string;
  origin: "parameter" | "local";
  annotation: string;
  narrowed: ("null" | "undefined")[];
  missing: ("null" | "undefined")[];
  guards: string[];
  uses: string[];
};

export type PartiallyNarrowedNullableEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  partials: PartialNarrowing[];
  callers: FunctionCaller[];
};

function unionMembers(annotation: string) {
  const parts = annotation.split("|").map((part) => part.trim());
  return {
    hasNull: parts.some((part) => part === "null"),
    hasUndefined: parts.some((part) => part === "undefined"),
  };
}

function declarationAnnotation(source: string, start: number, end: number): string | null {
  const text = source.slice(start, end);
  const colon = text.indexOf(":");
  if (colon < 0) return null;
  return text.slice(colon + 1).trim() || null;
}

function literalAbsence(expression: Expression): "null" | "undefined" | undefined {
  if (expression.type === "Literal" && expression.value === null) return "null";
  if (expression.type === "Identifier" && expression.name === "undefined") return "undefined";
  if (
    expression.type === "UnaryExpression"
    && expression.operator === "void"
  ) return "undefined";
  return undefined;
}

function narrowedByTest(test: Expression, binding: string): Set<"null" | "undefined"> {
  const narrowed = new Set<"null" | "undefined">();
  if (test.type !== "BinaryExpression") return narrowed;
  const { operator, left, right } = test;
  if (operator !== "===" && operator !== "!==" && operator !== "==" && operator !== "!=") {
    return narrowed;
  }
  const strict = operator === "===" || operator === "!==";
  const operands = [left, right];
  const identifier = operands.find((operand): operand is Expression & { type: "Identifier" } =>
    operand.type === "Identifier" && operand.name === binding
  );
  const other = operands.find((operand) => operand !== identifier);
  if (!identifier || !other) return narrowed;
  const absence = literalAbsence(other);
  if (absence) {
    if (strict) narrowed.add(absence);
    else {
      narrowed.add("null");
      narrowed.add("undefined");
    }
    return narrowed;
  }
  if (
    strict
    && other.type === "Literal"
    && other.value === "undefined"
  ) {
    narrowed.add("undefined");
    return narrowed;
  }
  return narrowed;
}

function narrowedByTypeof(test: Expression, binding: string): Set<"null" | "undefined"> {
  const narrowed = new Set<"null" | "undefined">();
  if (
    test.type === "BinaryExpression"
    && (test.operator === "===" || test.operator === "!==")
    && test.left.type === "UnaryExpression"
    && test.left.operator === "typeof"
    && test.left.argument.type === "Identifier"
    && test.left.argument.name === binding
    && test.right.type === "Literal"
    && test.right.value === "undefined"
  ) {
    narrowed.add("undefined");
  }
  return narrowed;
}

type BindingOrigin = {
  name: string;
  origin: "parameter" | "local";
  annotation: string;
};

function bindingOrigins(
  program: Program,
  fn: FunctionNode,
  source: string,
): BindingOrigin[] {
  const origins: BindingOrigin[] = [];
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    const target = value.type === "AssignmentPattern" && value.left.type === "Identifier"
      ? value.left
      : value.type === "Identifier"
        ? value
        : undefined;
    if (!target) continue;
    const annotation = declarationAnnotation(source, parameter.start, parameter.end);
    if (!annotation) continue;
    const { hasNull, hasUndefined } = unionMembers(annotation);
    const optional = /^\s*[A-Za-z_$][\w$]*\s*\?/.test(source.slice(parameter.start, parameter.end));
    if (hasNull && (hasUndefined || optional)) {
      origins.push({ name: target.name, origin: "parameter", annotation });
    }
  }
  const nested = nestedFunctionRanges(program, fn);
  new Visitor({
    VariableDeclarator(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.id.type !== "Identifier") return;
      const annotation = declarationAnnotation(source, node.id.start, node.id.end);
      if (!annotation) return;
      const { hasNull, hasUndefined } = unionMembers(annotation);
      if (hasNull && hasUndefined) {
        origins.push({ name: node.id.name, origin: "local", annotation });
      }
    },
  }).visit(program);
  return origins;
}

export function buildPartiallyNarrowedNullableEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): PartiallyNarrowedNullableEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const source = owner.source;
  const functionSource = source.slice(fn.start, fn.end);
  if (/\basserts\b/.test(functionSource)) return undefined;

  const origins = bindingOrigins(parsed.program, fn, source);
  if (origins.length === 0) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const direct = (node: { start: number; end: number }): boolean =>
    containsNode(fn, node) && belongsDirectlyToFunction(node, nested);

  const narrowed = new Map<string, Set<"null" | "undefined">>();
  const guards = new Map<string, string[]>();
  let nullishCoalesced = new Set<string>();

  const pushGuard = (binding: string, node: { start: number; end: number }): void => {
    const list = guards.get(binding) ?? [];
    if (list.length < 5) list.push(source.slice(node.start, node.end).slice(0, 240));
    guards.set(binding, list);
  };

  new Visitor({
    IfStatement(node) {
      if (!direct(node)) return;
      const names = origins.map(({ name }) => name);
      for (const binding of names) {
        const members = new Set<"null" | "undefined">([
          ...narrowedByTest(node.test, binding),
          ...narrowedByTypeof(node.test, binding),
        ]);
        const testText = source.slice(node.test.start, node.test.end);
        const truthiness = new RegExp(`^!\\s*${binding}$|^${binding}$`).test(testText.trim());
        const consequent = source.slice(node.consequent.start, node.consequent.end);
        const exits = /\breturn\b|\bthrow\b/.test(consequent);
        const addMembers = (values: Set<"null" | "undefined">): void => {
          const existing = narrowed.get(binding) ?? new Set<"null" | "undefined">();
          for (const member of values) existing.add(member);
          narrowed.set(binding, existing);
        };
        if (truthiness && exits) {
          addMembers(new Set(["null", "undefined"]));
          pushGuard(binding, node.test);
        } else if (members.size > 0) {
          addMembers(members);
          pushGuard(binding, node.test);
        }
      }
    },
    LogicalExpression(node) {
      if (!direct(node) || node.operator !== "??") return;
      if (node.left.type === "Identifier") {
        nullishCoalesced = new Set([...nullishCoalesced, node.left.name]);
      }
    },
  }).visit(parsed.program);

  const uses = new Map<string, string[]>();
  new Visitor({
    MemberExpression(node) {
      if (!direct(node) || node.object.type !== "Identifier") return;
      const list = uses.get(node.object.name) ?? [];
      if (list.length < 5) list.push(source.slice(node.start, node.end).slice(0, 240));
      uses.set(node.object.name, list);
    },
    CallExpression(node) {
      if (!direct(node)) return;
      if (node.callee.type === "Identifier") {
        const list = uses.get(node.callee.name) ?? [];
        if (list.length < 5) list.push(source.slice(node.start, node.end).slice(0, 240));
        uses.set(node.callee.name, list);
      }
    },
  }).visit(parsed.program);

  const partials: PartialNarrowing[] = [];
  for (const binding of origins) {
    if (nullishCoalesced.has(binding.name)) continue;
    const members = narrowed.get(binding.name) ?? new Set<"null" | "undefined">();
    if (members.size !== 1) continue;
    const bindingUses = uses.get(binding.name) ?? [];
    if (bindingUses.length === 0) continue;
    const narrowedList = [...members];
    const missing = (["null", "undefined"] as const).filter((member) => !members.has(member));
    partials.push({
      binding: binding.name,
      origin: binding.origin,
      annotation: binding.annotation.slice(0, 160),
      narrowed: narrowedList,
      missing,
      guards: guards.get(binding.name) ?? [],
      uses: bindingUses,
    });
  }

  if (partials.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    partials,
    callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
  };
}
