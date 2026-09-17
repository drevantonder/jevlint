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

export type SwapFinding = {
  kind: "duplicate-argument" | "unused-sibling" | "self-comparison" | "single-side-use";
  expression: string;
  usedIdentifier: string;
  unusedSibling: string | null;
};

export type ScopeBinding = {
  name: string;
  uses: number;
};

export type SiblingIdentifierSwapEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  scopeBindings: ScopeBinding[];
  findings: SwapFinding[];
  callers: FunctionCaller[];
};

const SUFFIX_PAIRS: Array<[string, string]> = [
  ["Start", "End"],
  ["Min", "Max"],
  ["First", "Last"],
  ["Old", "New"],
  ["Lower", "Upper"],
  ["Begin", "End"],
  ["Source", "Target"],
  ["Request", "Response"],
];

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootIdentifier(expression.object);
  }
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  return undefined;
}

function calleeText(expression: Expression, source: string): string {
  return source.slice(expression.start, expression.end);
}

function bindingName(parameter: FunctionNode["params"][number]): string | undefined {
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

export function buildSiblingIdentifierSwapEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): SiblingIdentifierSwapEvidence | undefined {
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

  const declared = new Map<string, number>();
  for (const parameter of fn.params) {
    const parameterName = bindingName(parameter);
    if (parameterName) declared.set(parameterName, parameter.start);
  }
  new Visitor({
    VariableDeclarator(node) {
      if (!direct(node) || node.id.type !== "Identifier") return;
      declared.set(node.id.name, node.start);
    },
  }).visit(parsed.program);

  const useCounts = new Map<string, number>();
  new Visitor({
    Identifier(node) {
      if (!direct(node) || !declared.has(node.name)) return;
      if (declared.get(node.name) === node.start) return;
      useCounts.set(node.name, (useCounts.get(node.name) ?? 0) + 1);
    },
  }).visit(parsed.program);

  const scopeBindings: ScopeBinding[] = [...declared.keys()].map((binding) => ({
    name: binding,
    uses: useCounts.get(binding) ?? 0,
  }));
  if (scopeBindings.length < 2) return undefined;
  const unused = scopeBindings.filter((binding) => binding.uses === 0);
  const findings: SwapFinding[] = [];

  const callsByCallee = new Map<string, Array<{ args: string[]; text: string }>>();
  new Visitor({
    CallExpression(node) {
      if (!direct(node)) return;
      const callee = calleeText(node.callee, owner.source);
      const args = node.arguments.map((argument) => {
        if (argument.type === "SpreadElement") return `...${owner.source.slice(argument.argument.start, argument.argument.end)}`;
        if (argument.type === "Identifier") return argument.name;
        return owner.source.slice(argument.start, argument.end);
      });
      const seen = new Set<string>();
      for (const argument of args) {
        if (argument.startsWith("...")) continue;
        if (/^[A-Za-z_$][\w$]*$/.test(argument) && declared.has(argument)) {
          if (seen.has(argument)) {
            findings.push({
              kind: "duplicate-argument",
              expression: owner.source.slice(node.start, node.end),
              usedIdentifier: argument,
              unusedSibling: unused[0]?.name ?? null,
            });
          }
          seen.add(argument);
        }
      }
      const calls = callsByCallee.get(callee) ?? [];
      calls.push({ args, text: owner.source.slice(node.start, node.end) });
      callsByCallee.set(callee, calls);
    },
    BinaryExpression(node) {
      if (!direct(node)) return;
      if (node.operator !== "===" && node.operator !== "!==") return;
      const left = rootIdentifier(node.left);
      const right = rootIdentifier(node.right);
      if (!left || left !== right) return;
      findings.push({
        kind: "self-comparison",
        expression: owner.source.slice(node.start, node.end),
        usedIdentifier: left,
        unusedSibling: null,
      });
    },
  }).visit(parsed.program);

  for (const calls of callsByCallee.values()) {
    if (calls.length < 2) continue;
    const first = calls[0];
    if (!first) continue;
    for (const call of calls.slice(1)) {
      for (const argument of call.args) {
        if (
          /^[A-Za-z_$][\w$]*$/.test(argument)
          && declared.has(argument)
          && first.args.includes(argument)
        ) {
          findings.push({
            kind: "duplicate-argument",
            expression: call.text,
            usedIdentifier: argument,
            unusedSibling: unused.find((binding) => binding.name !== argument)?.name ?? null,
          });
          break;
        }
      }
    }
  }

  for (const [first, second] of SUFFIX_PAIRS) {
    const stems = new Map<string, string[]>();
    for (const binding of declared.keys()) {
      const stem = binding.endsWith(first)
        ? binding.slice(0, binding.length - first.length)
        : binding.endsWith(second)
          ? binding.slice(0, binding.length - second.length)
          : null;
      if (stem === null || stem.length === 0) continue;
      const group = stems.get(stem) ?? [];
      group.push(binding);
      stems.set(stem, group);
    }
    for (const group of stems.values()) {
      if (group.length !== 2) continue;
      const one = group[0];
      const two = group[1];
      if (one === undefined || two === undefined) continue;
      const usesOne = useCounts.get(one) ?? 0;
      const usesTwo = useCounts.get(two) ?? 0;
      if (usesOne > 0 && usesTwo === 0) {
        findings.push({
          kind: "single-side-use",
          expression: candidate.source,
          usedIdentifier: one,
          unusedSibling: two,
        });
      } else if (usesTwo > 0 && usesOne === 0) {
        findings.push({
          kind: "single-side-use",
          expression: candidate.source,
          usedIdentifier: two,
          unusedSibling: one,
        });
      }
    }
  }

  if (unused.length > 0 && findings.some((finding) => finding.kind === "duplicate-argument")) {
    for (const binding of unused) {
      findings.push({
        kind: "unused-sibling",
        expression: candidate.source,
        usedIdentifier: findings.find((finding) => finding.kind === "duplicate-argument")?.usedIdentifier ?? "",
        unusedSibling: binding.name,
      });
    }
  }

  if (findings.length === 0) return undefined;
  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    scopeBindings,
    findings,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
