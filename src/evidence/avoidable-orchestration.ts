import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { AwaitExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  isInsideNestedFunction,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

type AwaitedStep = {
  binding: string | null;
  expression: string;
  dependsOn: string[];
};

type BindingRange = {
  name: string;
  start: number;
  end: number;
};

export type AvoidableOrchestrationEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  awaitedSteps: AwaitedStep[];
  callers: FunctionCaller[];
};

function bindingFor(awaited: AwaitExpression, ranges: BindingRange[]): string | null {
  return ranges.find((range) => range.start <= awaited.start && range.end >= awaited.end)?.name ?? null;
}

export function buildAvoidableOrchestrationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): AvoidableOrchestrationEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const awaits: AwaitExpression[] = [];
  const bindings: BindingRange[] = [];
  const nestedFunctions = nestedFunctionRanges(parsed.program, candidate);
  new Visitor({
    AwaitExpression(node) {
      if (
        node.start >= candidate.start
        && node.end <= candidate.end
        && !isInsideNestedFunction(node, nestedFunctions)
      ) awaits.push(node);
    },
    VariableDeclarator(node) {
      if (
        node.start >= candidate.start
        && node.end <= candidate.end
        && !isInsideNestedFunction(node, nestedFunctions)
        && node.id.type === "Identifier"
        && node.init
      ) {
        bindings.push({ name: node.id.name, start: node.init.start, end: node.init.end });
      }
    },
  }).visit(parsed.program);
  awaits.sort((left, right) => left.start - right.start);
  if (awaits.length < 2) return undefined;

  const priorBindings: string[] = [];
  const awaitedSteps = awaits.map((awaited): AwaitedStep => {
    const expression = owner.source.slice(awaited.argument.start, awaited.argument.end);
    const binding = bindingFor(awaited, bindings);
    const dependsOn = priorBindings.filter((prior) =>
      new RegExp(`\\b${prior}\\b`).test(expression),
    );
    if (binding) priorBindings.push(binding);
    return { binding, expression, dependsOn };
  });

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    awaitedSteps,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
