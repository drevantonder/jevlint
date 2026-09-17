import { parseSync, Visitor } from "oxc-parser";
import type { Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type QuantityFlow = {
  name: string;
  kind: "parameter" | "local";
  hasUnit: boolean;
  annotation: string | null;
  sinkCalls: string[];
  source: string;
};

export type CallerQuantity = {
  filePath: string;
  call: string;
  argument: string;
  line: number;
};

export type UnitlessQuantityEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  quantities: QuantityFlow[];
  callerQuantities: CallerQuantity[];
  callers: FunctionCaller[];
};

const SINK_CALLEE = /setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame|\bDate\b|\bBuffer\b|delay|sleep|throttle|debounce|expir|ttl|timeout/i;
const UNIT_SUFFIX = /(Ms|Millis|Milliseconds|Seconds?|Secs?|Minutes?|Mins?|Hours?|Hrs?|Days?|Weeks?|Bytes?|KB|MB|GB|Pixels?|Px|Percent|Pct|Degrees?|Deg|Radians?|Rad)([A-Z]|$)/;
const TIME_CONSTANTS = new Set(["1000", "60", "24", "3600", "1024"]);

function bindingName(parameter: FunctionNode["params"][number]): string | undefined {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
    return value.left.name;
  }
  if (value.type === "RestElement" && value.argument.type === "Identifier") {
    return value.argument.name;
  }
  if (value.type !== "Identifier") return undefined;
  return value.name;
}

function annotationOf(
  parameter: FunctionNode["params"][number],
  source: string,
): string | null {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  const identifier = value.type === "AssignmentPattern" && value.left.type === "Identifier"
    ? value.left
    : value.type === "Identifier"
      ? value
      : null;
  if (!identifier?.typeAnnotation) return null;
  return source
    .slice(identifier.typeAnnotation.start, identifier.typeAnnotation.end)
    .replace(/^:\s*/, "");
}

function isNumericLiteral(node: Expression): boolean {
  return node.type === "Literal" && Number.isFinite(node.value);
}

function isNumeric(annotation: string | null, init: Expression | null): boolean {
  if (annotation !== null) return /(^|\W)number(\W|$)/i.test(annotation);
  if (init === null) return false;
  return isNumericLiteral(init);
}

function hasUnit(name: string, annotation: string | null): boolean {
  if (UNIT_SUFFIX.test(name)) return true;
  return annotation !== null && !/^\s*number\s*$/.test(annotation);
}

function calleeText(callee: Expression, source: string): string {
  return source.slice(callee.start, callee.end).slice(0, 120);
}

function numericLiteralText(node: Expression): string | null {
  if (!isNumericLiteral(node) || node.type !== "Literal") return null;
  return String(node.value);
}

export function buildUnitlessQuantityEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnitlessQuantityEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const direct = (node: { start: number; end: number }): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !nested.some((range) => range.start <= node.start && range.end >= node.end);

  type NumericBinding = {
    name: string;
    kind: "parameter" | "local";
    annotation: string | null;
    paramIndex: number | null;
    source: string;
  };
  const numerics: NumericBinding[] = [];
  fn.params.forEach((parameter, index) => {
    const paramName = bindingName(parameter);
    if (!paramName) return;
    const annotation = annotationOf(parameter, owner.source);
    const init = parameter.type === "AssignmentPattern" ? parameter.right : null;
    if (!isNumeric(annotation, init)) return;
    numerics.push({
      name: paramName,
      kind: "parameter",
      annotation,
      paramIndex: index,
      source: owner.source.slice(parameter.start, parameter.end).slice(0, 300),
    });
  });
  new Visitor({
    VariableDeclarator(node) {
      if (!direct(node) || node.id.type !== "Identifier") return;
      const annotation = node.id.typeAnnotation
        ? owner.source
          .slice(node.id.typeAnnotation.start, node.id.typeAnnotation.end)
          .replace(/^:\s*/, "")
        : null;
      if (!isNumeric(annotation, node.init)) return;
      numerics.push({
        name: node.id.name,
        kind: "local",
        annotation,
        paramIndex: null,
        source: owner.source.slice(node.start, node.end).slice(0, 300),
      });
    },
  }).visit(parsed.program);

  const unitless = numerics.filter(
    (binding) => !hasUnit(binding.name, binding.annotation),
  );
  if (unitless.length === 0) return undefined;
  const names = new Set(unitless.map((binding) => binding.name));

  const sinkCallsByName = new Map<string, string[]>();
  const identifierOffsets = new Map<string, number[]>();
  new Visitor({
    Identifier(node) {
      if (!direct(node)) return;
      const list = identifierOffsets.get(node.name) ?? [];
      list.push(node.start);
      identifierOffsets.set(node.name, list);
    },
  }).visit(parsed.program);
  const usesIdentifier = (node: { start: number; end: number }, target: string): boolean =>
    (identifierOffsets.get(target) ?? []).some(
      (offset) => offset >= node.start && offset <= node.end,
    );
  new Visitor({
    CallExpression(node) {
      if (!direct(node)) return;
      const callee = calleeText(node.callee, owner.source);
      if (!SINK_CALLEE.test(callee)) return;
      for (const target of names) {
        if (!usesIdentifier(node, target)) continue;
        const list = sinkCallsByName.get(target) ?? [];
        if (list.length < 10) {
          list.push(`${callee}(${node.arguments.map((argument) => owner.source.slice(argument.start, argument.end).slice(0, 80)).join(", ")})`);
        }
        sinkCallsByName.set(target, list);
      }
    },
    NewExpression(node) {
      if (!direct(node)) return;
      const callee = calleeText(node.callee, owner.source);
      if (!SINK_CALLEE.test(callee)) return;
      for (const target of names) {
        if (!usesIdentifier(node, target)) continue;
        const list = sinkCallsByName.get(target) ?? [];
        if (list.length < 10) list.push(`new ${callee}(…)`);
        sinkCallsByName.set(target, list);
      }
    },
    BinaryExpression(node) {
      if (!direct(node)) return;
      if (node.operator !== "*" && node.operator !== "/" && node.operator !== "%") return;
      const literal = numericLiteralText(node.left) ?? numericLiteralText(node.right);
      if (!literal || !TIME_CONSTANTS.has(literal)) return;
      for (const target of names) {
        if (!usesIdentifier(node, target)) continue;
        const list = sinkCallsByName.get(target) ?? [];
        if (list.length < 10) {
          list.push(`time-scale arithmetic with ${literal}: ${owner.source.slice(node.start, node.end).slice(0, 120)}`);
        }
        sinkCallsByName.set(target, list);
      }
    },
  }).visit(parsed.program);

  const callers = findFunctionCallers(owner.filePath, name, projectFiles);
  const callerQuantities: CallerQuantity[] = [];
  for (const caller of callers) {
    for (const binding of unitless) {
      if (binding.paramIndex === null) continue;
      const argument = caller.arguments[binding.paramIndex];
      if (argument === undefined) continue;
      const trimmed = argument.trim();
      if (trimmed.length === 0 || !Number.isFinite(Number(trimmed))) continue;
      if (callerQuantities.length >= 20) break;
      callerQuantities.push({
        filePath: caller.filePath,
        call: caller.call.slice(0, 200),
        argument: argument.trim(),
        line: caller.line,
      });
    }
  }

  const quantities = unitless.map((binding): QuantityFlow => ({
    name: binding.name,
    kind: binding.kind,
    hasUnit: false,
    annotation: binding.annotation,
    sinkCalls: sinkCallsByName.get(binding.name) ?? [],
    source: binding.source,
  }));

  const relevant = quantities.filter(
    (quantity) => quantity.sinkCalls.length > 0
      || (quantity.kind === "parameter" && callerQuantities.length > 0),
  );
  if (relevant.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    quantities: relevant,
    callerQuantities,
    callers,
  };
}
