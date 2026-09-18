import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type PreGateEffect = {
  operation: string;
  target: string | null;
  importedFrom: string | null;
};

export type RejectingGate = {
  condition: string;
  exitKind: "return" | "throw" | "response";
};

export type PreGateSideEffectEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  effects: PreGateEffect[];
  gates: RejectingGate[];
  compensatingCleanup: string[];
  callers: FunctionCaller[];
};

const EFFECT_METHODS = new Set([
  "set",
  "track",
  "send",
  "insert",
  "save",
  "create",
  "update",
  "upsert",
  "publish",
  "emit",
  "record",
  "persist",
  "store",
  "write",
  "notify",
  "enqueue",
  "dispatch",
  "commit",
]);

const CLEANUP_METHODS = new Set([
  "delete",
  "remove",
  "clear",
  "rollback",
  "revert",
  "undo",
  "invalidate",
]);

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootIdentifier(expression.object);
  }
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  return undefined;
}

function unwrapCall(expression: Expression): CallExpression | undefined {
  if (expression.type === "CallExpression") return expression;
  if (expression.type === "AwaitExpression" && expression.argument.type === "CallExpression") {
    return expression.argument;
  }
  if (expression.type === "ChainExpression" && expression.expression.type === "CallExpression") {
    return expression.expression;
  }
  return undefined;
}

function methodName(call: CallExpression): string | undefined {
  if (call.callee.type !== "MemberExpression" || call.callee.computed) return undefined;
  return call.callee.property.type === "Identifier" ? call.callee.property.name : undefined;
}

function localNames(program: Parameters<Visitor["visit"]>[0], candidate: Candidate): Set<string> {
  const result = new Set<string>();
  new Visitor({
    VariableDeclarator(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (node.id.type === "Identifier") result.add(node.id.name);
    },
  }).visit(program);
  return result;
}

function exitKindOf(source: string, start: number, end: number): RejectingGate["exitKind"] | undefined {
  const text = source.slice(start, end);
  if (/\bthrow\b/.test(text)) return "throw";
  if (/\breturn\b/.test(text)) return "return";
  if (/\.(send|json|end|status)\s*\(/.test(text)) return "response";
  return undefined;
}

export function buildPreGateSideEffectEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): PreGateSideEffectEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
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
  const locals = localNames(parsed.program, candidate);
  const imports = moduleImports(parsed.program);

  type TimedEffect = PreGateEffect & { start: number };
  type TimedGate = RejectingGate & { start: number };
  const effects: TimedEffect[] = [];
  const gates: TimedGate[] = [];
  const cleanups: string[] = [];

  new Visitor({
    ExpressionStatement(node) {
      if (!direct(node)) return;
      const call = unwrapCall(node.expression);
      if (!call) return;
      const root = rootIdentifier(call.callee);
      if (root === "fetch") {
        effects.push({
          operation: owner.source.slice(call.start, call.end),
          target: "fetch",
          importedFrom: null,
          start: node.start,
        });
        return;
      }
      const method = methodName(call);
      if (!method || !EFFECT_METHODS.has(method) || !root || locals.has(root)) return;
      const imported = imports.find(({ local }) => local === root);
      effects.push({
        operation: owner.source.slice(call.start, call.end),
        target: root,
        importedFrom: imported?.source ?? null,
        start: node.start,
      });
      if (CLEANUP_METHODS.has(method)) cleanups.push(owner.source.slice(call.start, call.end));
    },
    IfStatement(node) {
      if (!direct(node)) return;
      const consequent = node.consequent;
      const alternate = node.alternate;
      const branches = [consequent, alternate].filter((branch) => branch !== null);
      for (const branch of branches) {
        if (!branch) continue;
        const exit = exitKindOf(owner.source, branch.start, branch.end);
        if (!exit) continue;
        gates.push({
          condition: owner.source.slice(node.test.start, node.test.end),
          exitKind: exit,
          start: node.start,
        });
        break;
      }
    },
  }).visit(parsed.program);

  const ordered = effects.filter((effect) =>
    gates.some((gate) => effect.start < gate.start)
  );
  if (ordered.length === 0) return undefined;

  effects.sort((left, right) => left.start - right.start);
  gates.sort((left, right) => left.start - right.start);
  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    effects: effects.map(({ operation, target, importedFrom }) => ({
      operation,
      target,
      importedFrom,
    })),
    gates: gates.map(({ condition, exitKind }) => ({ condition, exitKind })),
    compensatingCleanup: cleanups,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
