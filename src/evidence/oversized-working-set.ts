import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type WorkingSetBinding = {
  name: string;
  role: "parameter" | "local" | "assigned";
  declaredLine: number;
  lastUseLine: number;
  useCount: number;
  feedsNext: boolean;
};

export type OversizedWorkingSetEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  totalBindings: number;
  maxConcurrentLive: number;
  longestFeedChain: number;
  bindings: WorkingSetBinding[];
  callers: FunctionCaller[];
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

export function buildOversizedWorkingSetEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): OversizedWorkingSetEvidence | undefined {
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

  const declared = new Map<string, { role: "parameter" | "local" | "assigned"; line: number; start: number }>();
  for (const parameter of fn.params) {
    const binding = bindingName(parameter);
    if (binding && !declared.has(binding)) {
      declared.set(binding, {
        role: "parameter",
        line: lineAt(owner.source, parameter.start),
        start: parameter.start,
      });
    }
  }

  const localInits = new Map<string, string>();
  new Visitor({
    VariableDeclarator(node) {
      if (!direct(node) || node.id.type !== "Identifier") return;
      if (!declared.has(node.id.name)) {
        declared.set(node.id.name, {
          role: "local",
          line: lineAt(owner.source, node.start),
          start: node.start,
        });
      }
      if (node.init && !localInits.has(node.id.name)) {
        localInits.set(node.id.name, owner.source.slice(node.init.start, node.init.end));
      }
    },
  }).visit(parsed.program);

  const assignedTargets = new Map<string, number>();
  new Visitor({
    AssignmentExpression(node) {
      if (!direct(node) || node.left.type !== "Identifier") return;
      if (!assignedTargets.has(node.left.name)) {
        assignedTargets.set(node.left.name, lineAt(owner.source, node.start));
      }
    },
    UpdateExpression(node) {
      if (!direct(node) || node.argument.type !== "Identifier") return;
      if (!assignedTargets.has(node.argument.name)) {
        assignedTargets.set(node.argument.name, lineAt(owner.source, node.start));
      }
    },
  }).visit(parsed.program);

  for (const [target, line] of assignedTargets) {
    if (!declared.has(target)) {
      declared.set(target, { role: "assigned", line, start: candidate.start });
    }
  }

  if (declared.size < 3) return undefined;

  const uses = new Map<string, number[]>();
  new Visitor({
    Identifier(node) {
      if (!direct(node) || !declared.has(node.name)) return;
      if (declared.get(node.name)?.start === node.start) return;
      const lines = uses.get(node.name) ?? [];
      lines.push(lineAt(owner.source, node.start));
      uses.set(node.name, lines);
    },
  }).visit(parsed.program);

  const ordered = [...declared.entries()].sort((left, right) => left[1].line - right[1].line);
  const bindings: WorkingSetBinding[] = ordered.map(([binding, info]) => {
    const useLines = uses.get(binding) ?? [];
    return {
      name: binding,
      role: info.role,
      declaredLine: info.line,
      lastUseLine: useLines.length > 0 ? Math.max(...useLines) : info.line,
      useCount: useLines.length,
      feedsNext: false,
    };
  });

  for (let index = 0; index < bindings.length - 1; index += 1) {
    const current = bindings[index];
    const next = bindings[index + 1];
    if (!current || !next) continue;
    const nextInit = localInits.get(next.name) ?? "";
    if (nextInit !== "") {
      const pattern = new RegExp(`\\b${escapeRegExp(current.name)}\\b`);
      if (pattern.test(nextInit)) current.feedsNext = true;
    }
  }

  let longestFeedChain = 0;
  let run = 0;
  for (const binding of bindings) {
    if (binding.feedsNext) {
      run += 1;
      if (run + 1 > longestFeedChain) longestFeedChain = run + 1;
    } else {
      run = 0;
      if (longestFeedChain === 0) longestFeedChain = Math.max(longestFeedChain, 1);
    }
  }
  if (bindings.length > 0 && longestFeedChain === 0) longestFeedChain = 1;

  const lines = new Set<number>();
  for (const binding of bindings) {
    for (let line = binding.declaredLine; line <= binding.lastUseLine; line += 1) {
      lines.add(line);
    }
  }
  let maxConcurrentLive = 0;
  for (const line of lines) {
    const live = bindings.filter(({ declaredLine, lastUseLine }) =>
      declaredLine <= line && lastUseLine >= line
    ).length;
    if (live > maxConcurrentLive) maxConcurrentLive = live;
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    totalBindings: declared.size,
    maxConcurrentLive,
    longestFeedChain,
    bindings: bindings.slice(0, 30),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
