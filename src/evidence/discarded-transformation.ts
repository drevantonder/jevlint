import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Argument, CallExpression } from "oxc-parser";
import type { Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  isInsideNestedFunction,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

const TRANSFORM_METHODS = new Set(["map", "filter", "flatMap", "reduce"]);

export type DiscardedTransformationSite = {
  method: string;
  call: string;
  resultUse: "bare-statement" | "assigned-never-read";
  callback: {
    source: string | null;
    mutatesOuter: boolean;
    performsCall: boolean;
    hasReturn: boolean;
  };
};

export type DiscardedTransformationEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  sites: DiscardedTransformationSite[];
  callers: FunctionCaller[];
};

type SourceRange = { start: number; end: number };

function isTransformCall(call: CallExpression): string | undefined {
  const callee = call.callee.type === "ChainExpression" ? call.callee.expression : call.callee;
  if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier") {
    return undefined;
  }
  return TRANSFORM_METHODS.has(callee.property.name) ? callee.property.name : undefined;
}

function asCallback(argument: Argument | undefined): FunctionNode | undefined {
  if (
    argument?.type === "ArrowFunctionExpression" || argument?.type === "FunctionExpression"
  ) return argument;
  return undefined;
}

export function buildDiscardedTransformationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DiscardedTransformationEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nestedFunctions = nestedFunctionRanges(parsed.program, candidate);
  const inScope = (node: Node): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !isInsideNestedFunction(node, nestedFunctions);

  const outerBindings = new Set<string>();
  for (const parameter of fn.params) {
    const match = /^(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(
      owner.source.slice(parameter.start, parameter.end).trim(),
    );
    if (match?.[1]) outerBindings.add(match[1]);
  }

  const bareCalls: CallExpression[] = [];
  const assignedUnread: { call: CallExpression; binding: string }[] = [];
  const mutationRanges: SourceRange[] = [];
  const callRanges: SourceRange[] = [];
  const returnRanges: SourceRange[] = [];
  const inCandidate = (node: SourceRange): boolean =>
    node.start >= candidate.start && node.end <= candidate.end;
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type === "Identifier" && inScope(node)) outerBindings.add(node.id.name);
      if (node.id.type !== "Identifier" || !node.init || !inScope(node)) return;
      const init = node.init.type === "ChainExpression" ? node.init.expression : node.init;
      if (init.type !== "CallExpression" || !isTransformCall(init)) return;
      const rest = owner.source.slice(node.end, candidate.end);
      if (!new RegExp(`\\b${node.id.name}\\b`).test(rest)) {
        assignedUnread.push({ call: init, binding: node.id.name });
      }
    },
    ExpressionStatement(node) {
      if (!inScope(node)) return;
      const expression = node.expression.type === "ChainExpression"
        ? node.expression.expression
        : node.expression;
      if (expression.type === "CallExpression" && isTransformCall(expression)) {
        bareCalls.push(expression);
      }
    },
    AssignmentExpression(node) {
      if (!inCandidate(node) || node.left.type !== "Identifier") return;
      if (outerBindings.has(node.left.name)) {
        mutationRanges.push({ start: node.start, end: node.end });
      }
    },
    UpdateExpression(node) {
      if (!inCandidate(node) || node.argument.type !== "Identifier") return;
      if (outerBindings.has(node.argument.name)) {
        mutationRanges.push({ start: node.start, end: node.end });
      }
    },
    CallExpression(node) {
      if (inCandidate(node)) callRanges.push({ start: node.start, end: node.end });
    },
    ReturnStatement(node) {
      if (inCandidate(node) && node.argument) returnRanges.push({ start: node.start, end: node.end });
    },
  }).visit(parsed.program);

  if (bareCalls.length === 0 && assignedUnread.length === 0) return undefined;

  const callbackFacts = (callback: FunctionNode | undefined): DiscardedTransformationSite["callback"] => {
    if (!callback) {
      return { source: null, mutatesOuter: false, performsCall: false, hasReturn: false };
    }
    const inside = ({ start, end }: SourceRange): boolean =>
      start >= callback.start
      && end <= callback.end
      && (start !== callback.start || end !== callback.end);
    return {
      source: owner.source.slice(callback.start, callback.end).slice(0, 800),
      mutatesOuter: mutationRanges.some(inside),
      performsCall: callRanges.some(
        (range) => inside(range) && (range.start !== callback.start || range.end !== callback.end),
      ),
      hasReturn: returnRanges.some(inside),
    };
  };

  const sites: DiscardedTransformationSite[] = [];
  for (const call of bareCalls) {
    sites.push({
      method: isTransformCall(call) ?? "map",
      call: owner.source.slice(call.start, call.end).slice(0, 500),
      resultUse: "bare-statement",
      callback: callbackFacts(asCallback(call.arguments[0])),
    });
  }
  for (const { call, binding } of assignedUnread) {
    sites.push({
      method: isTransformCall(call) ?? "map",
      call: `${binding} = ${owner.source.slice(call.start, call.end).slice(0, 400)}`,
      resultUse: "assigned-never-read",
      callback: callbackFacts(asCallback(call.arguments[0])),
    });
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    sites,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
