import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Expression, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import {
  calleeRootName,
  findNamedFunction,
  moduleImports,
  resolveModule,
  type FunctionNode,
} from "./repository.js";
import { parseTestFunction } from "./test-scope.js";

export type DoubledHelper = {
  helper: string;
  helperFile: string;
  analyzable: boolean;
  pure: boolean;
  impuritySignals: string[];
  helperSource: string | null;
  cannedValues: string[];
};

export type DoubledPureHelperEvidence = {
  test: {
    title: string | null;
    filePath: string;
    source: string;
  };
  doubles: DoubledHelper[];
  otherProjectCalls: string[];
};

const IO_ROOTS = new Set([
  "fetch",
  "console",
  "process",
  "fs",
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "WebSocket",
  "XMLHttpRequest",
  "navigator",
  "location",
]);

const NONDETERMINISM_PATTERN = /\b(?:Math\s*\.\s*random|Date\s*\.\s*now|performance\s*\.\s*now)\b/;

function stringArgument(call: CallExpression, source: string): string | null {
  const first = call.arguments[0];
  if (!first || first.type === "SpreadElement" || first.type !== "Literal") return null;
  const raw = source.slice(first.start, first.end);
  const quote = raw[0];
  if (quote !== "\"" && quote !== "'" && quote !== "`") return null;
  if (raw.length < 2 || raw[raw.length - 1] !== quote) return null;
  return raw.slice(1, -1);
}

function isModuleMock(call: CallExpression, source: string): boolean {
  const root = calleeRootName(call.callee);
  if (root !== "vi" && root !== "vitest" && root !== "jest") return false;
  const text = source.slice(call.start, call.end);
  return /\.\s*mock\s*\(/.test(text);
}

function referencedNames(fn: FunctionNode, program: Program): Set<string> {
  const names = new Set<string>();
  new Visitor({
    Identifier(node) {
      if (containsNode(fn, node)) names.add(node.name);
    },
  }).visit(program);
  return names;
}

function parameterNames(fn: FunctionNode): Set<string> {
  const names = new Set<string>();
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    if (value.type === "Identifier") names.add(value.name);
    else if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
      names.add(value.left.name);
    } else if (value.type === "RestElement" && value.argument.type === "Identifier") {
      names.add(value.argument.name);
    }
  }
  return names;
}

function memberRoot(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") return memberRoot(expression.object);
  if (expression.type === "ChainExpression") return memberRoot(expression.expression);
  return undefined;
}

function puritySignals(
  fn: FunctionNode,
  program: Program,
  source: string,
): string[] {
  const signals: string[] = [];
  const parameters = parameterNames(fn);
  const nested = nestedFunctionRanges(program, fn);
  const push = (signal: string): void => {
    if (signals.length < 10) signals.push(signal.slice(0, 160));
  };
  new Visitor({
    ThrowStatement(node) {
      if (containsNode(fn, node)) push(`throw: ${source.slice(node.start, node.end)}`);
    },
    AwaitExpression(node) {
      if (containsNode(fn, node)) push(`await: ${source.slice(node.start, node.end)}`);
    },
    CallExpression(node) {
      if (!containsNode(fn, node)) return;
      const text = source.slice(node.start, node.end);
      const root = calleeRootName(node.callee);
      if (root && IO_ROOTS.has(root)) push(`io: ${text}`);
      if (NONDETERMINISM_PATTERN.test(text)) push(`nondeterminism: ${text}`);
    },
    NewExpression(node) {
      if (!containsNode(fn, node)) return;
      const text = source.slice(node.start, node.end);
      if (/^\s*new\s+Date\s*\(\s*\)/.test(text)) push(`nondeterminism: ${text}`);
    },
    AssignmentExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.left.type === "MemberExpression") {
        const root = memberRoot(node.left.object);
        if (root && parameters.has(root)) {
          push(`mutates-parameter: ${source.slice(node.start, node.end)}`);
        }
      }
    },
    UpdateExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.argument.type === "MemberExpression") {
        const root = memberRoot(node.argument.object);
        if (root && parameters.has(root)) {
          push(`mutates-parameter: ${source.slice(node.start, node.end)}`);
        }
      }
    },
  }).visit(program);
  return signals;
}

function cannedValues(fn: FunctionNode, program: Program, source: string): string[] {
  const values: string[] = [];
  new Visitor({
    CallExpression(call) {
      if (!containsNode(fn, call)) return;
      const text = source.slice(call.start, call.end);
      if (/\bmock(ReturnValue|ResolvedValue|RejectedValue|Implementation)\s*\(/.test(text)) {
        values.push(text.slice(0, 200));
      }
    },
  }).visit(program);
  return values.slice(0, 5);
}

export function buildDoubledPureHelperEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DoubledPureHelperEvidence | undefined {
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  if (scope.runner !== "it" && scope.runner !== "test") return undefined;
  const { owner, program, fn } = scope;

  const mockedSpecifiers = new Map<string, string>();
  new Visitor({
    CallExpression(call) {
      if (!isModuleMock(call, owner.source)) return;
      const specifier = stringArgument(call, owner.source);
      if (specifier && !mockedSpecifiers.has(specifier)) {
        mockedSpecifiers.set(specifier, owner.source.slice(call.start, call.end).slice(0, 200));
      }
    },
  }).visit(program);
  if (mockedSpecifiers.size === 0) return undefined;

  const imports = moduleImports(program);
  const used = referencedNames(fn, program);
  const doubles: DoubledHelper[] = [];

  for (const specifier of mockedSpecifiers.keys()) {
    if (!specifier.startsWith(".")) continue;
    const target = resolveModule(owner.filePath, specifier, projectFiles);
    if (!target) continue;
    const targetParsed = parseCached(target.filePath, target.source);
    if (targetParsed.errors.some((error) => error.severity === "Error")) continue;
    const doubledLocals = imports
      .filter((entry) => entry.source === specifier && entry.imported !== "*" && used.has(entry.local))
      .map((entry) => ({ local: entry.local, imported: entry.imported }));
    for (const { local, imported } of doubledLocals.slice(0, 5)) {
      if (imported === "default") continue;
      const helper = findNamedFunction(targetParsed.program, imported);
      if (!helper) {
        doubles.push({
          helper: local,
          helperFile: target.filePath,
          analyzable: false,
          pure: false,
          impuritySignals: [],
          helperSource: null,
          cannedValues: cannedValues(fn, program, owner.source),
        });
        continue;
      }
      const signals = puritySignals(helper, targetParsed.program, target.source);
      doubles.push({
        helper: local,
        helperFile: target.filePath,
        analyzable: true,
        pure: signals.length === 0,
        impuritySignals: signals,
        helperSource: target.source.slice(helper.start, helper.end).slice(0, 800),
        cannedValues: cannedValues(fn, program, owner.source),
      });
    }
  }

  if (!doubles.some(({ analyzable }) => analyzable)) return undefined;
  const doubledLocals = new Set(doubles.map(({ helper }) => helper));
  const otherProjectCalls = imports
    .filter((entry) => entry.source.startsWith(".") && used.has(entry.local) && !doubledLocals.has(entry.local))
    .map((entry) => entry.local)
    .slice(0, 10);
  return {
    test: {
      title: scope.title,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    doubles: doubles.slice(0, 10),
    otherProjectCalls,
  };
}
