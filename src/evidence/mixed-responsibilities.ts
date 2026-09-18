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
  resolveModule,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

type CollaboratorCall = {
  expression: string;
  line: number;
};

type CollaboratorEvidence = {
  source: string;
  ownership: "project-module" | "external-package" | "unresolved";
  bindings: Array<{ local: string; imported: string }>;
  module: { filePath: string; source: string } | null;
  calls: CollaboratorCall[];
};

export type MixedResponsibilitiesEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  collaborators: CollaboratorEvidence[];
  callers: FunctionCaller[];
};

type Range = {
  start: number;
  end: number;
};

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") return rootIdentifier(expression.object);
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  if (expression.type === "TSInstantiationExpression") return rootIdentifier(expression.expression);
  return undefined;
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function insideNestedFunction(call: CallExpression, nestedFunctions: Range[]): boolean {
  return nestedFunctions.some(({ start, end }) => start <= call.start && end >= call.end);
}

export function buildMixedResponsibilitiesEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): MixedResponsibilitiesEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const imports = moduleImports(parsed.program);
  const importsByLocal = new Map(imports.map((imported) => [imported.local, imported]));
  const nestedFunctions: Range[] = [];
  new Visitor({
    ArrowFunctionExpression(node) {
      if (node.start > candidate.start && node.end < candidate.end) nestedFunctions.push(node);
    },
    FunctionDeclaration(node) {
      if (node.start > candidate.start && node.end < candidate.end) nestedFunctions.push(node);
    },
    FunctionExpression(node) {
      if (node.start > candidate.start && node.end < candidate.end) nestedFunctions.push(node);
    },
  }).visit(parsed.program);

  const callsBySource = new Map<string, CollaboratorCall[]>();
  new Visitor({
    CallExpression(call) {
      if (call.start < candidate.start || call.end > candidate.end) return;
      if (insideNestedFunction(call, nestedFunctions)) return;
      const root = rootIdentifier(call.callee);
      if (!root) return;
      const imported = importsByLocal.get(root);
      if (!imported) return;
      const calls = callsBySource.get(imported.source) ?? [];
      calls.push({
        expression: owner.source.slice(call.start, call.end),
        line: lineAt(owner.source, call.start),
      });
      callsBySource.set(imported.source, calls);
    },
  }).visit(parsed.program);

  if (callsBySource.size < 2) return undefined;
  const collaborators = [...callsBySource].slice(0, 8).map(([source, calls]): CollaboratorEvidence => {
    const target = resolveModule(owner.filePath, source, projectFiles);
    return {
      source,
      ownership: target
        ? "project-module"
        : source.startsWith(".") ? "unresolved" : "external-package",
      bindings: imports
        .filter((imported) => imported.source === source)
        .map(({ local, imported }) => ({ local, imported })),
      module: target
        ? { filePath: target.filePath, source: target.source.slice(0, 6_000) }
        : null,
      calls: calls.slice(0, 20),
    };
  });

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    collaborators,
    callers: findFunctionCallers(owner.filePath, name, projectFiles),
  };
}
