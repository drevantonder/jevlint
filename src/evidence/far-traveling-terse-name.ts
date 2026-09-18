import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type TravelingTerseBinding = {
  name: string;
  kind: "param" | "local" | "catch-param" | "loop-variable";
  declarationLine: number;
  lastUseLine: number;
  spanLines: number;
  uses: number;
  exposedByExport: boolean;
  capturedAcrossClosure: boolean;
  captureDepth: number;
};

export type FarTravelingTerseNameEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    startLine: number;
    endLine: number;
  };
  bindings: TravelingTerseBinding[];
  functionSpanLines: number;
  callers: FunctionCaller[];
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function isTerse(name: string): boolean {
  const stripped = name.replace(/^_+/u, "");
  return stripped.length >= 1 && stripped.length <= 3;
}

function paramName(parameter: FunctionNode["params"][number]): {
  name: string;
  start: number;
} | undefined {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "Identifier") return { name: value.name, start: value.start };
  if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
    return { name: value.left.name, start: value.left.start };
  }
  if (value.type === "RestElement" && value.argument.type === "Identifier") {
    return { name: value.argument.name, start: value.argument.start };
  }
  return undefined;
}

function useOffsets(functionSource: string, name: string): number[] {
  const matches = functionSource.matchAll(new RegExp(`\\b${name}\\b`, "gu"));
  return [...matches].map((match) => match.index ?? 0);
}

export function buildFarTravelingTerseNameEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): FarTravelingTerseNameEvidence | undefined {
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

  const loopHeaderStarts = new Set<number>();
  new Visitor({
    ForStatement(node) {
      const init = node.init;
      if (init?.type === "VariableDeclaration") {
        for (const declaration of init.declarations) {
          if (declaration.id.type === "Identifier") loopHeaderStarts.add(declaration.id.start);
        }
      }
    },
    ForInStatement(node) {
      const left = node.left;
      if (left.type === "VariableDeclaration") {
        for (const declaration of left.declarations) {
          if (declaration.id.type === "Identifier") loopHeaderStarts.add(declaration.id.start);
        }
      } else if (left.type === "Identifier") {
        loopHeaderStarts.add(left.start);
      }
    },
    ForOfStatement(node) {
      const left = node.left;
      if (left.type === "VariableDeclaration") {
        for (const declaration of left.declarations) {
          if (declaration.id.type === "Identifier") loopHeaderStarts.add(declaration.id.start);
        }
      } else if (left.type === "Identifier") {
        loopHeaderStarts.add(left.start);
      }
    },
  }).visit(parsed.program);

  const declared: {
    name: string;
    kind: TravelingTerseBinding["kind"];
    start: number;
  }[] = [];
  for (const parameter of fn.params) {
    const binding = paramName(parameter);
    if (binding) declared.push({ ...binding, kind: "param" });
  }
  new Visitor({
    VariableDeclarator(node) {
      if (!direct(node) || node.id.type !== "Identifier") return;
      declared.push({
        name: node.id.name,
        kind: loopHeaderStarts.has(node.id.start) ? "loop-variable" : "local",
        start: node.id.start,
      });
    },
    CatchClause(node) {
      if (!direct(node)) return;
      const param = node.param;
      if (param?.type === "Identifier") {
        declared.push({ name: param.name, kind: "catch-param", start: param.start });
      }
    },
  }).visit(parsed.program);

  const exported = isFunctionExported(parsed.program, fn, name);
  const functionSource = owner.source.slice(fn.start, fn.end);
  const startLine = lineAt(owner.source, fn.start);
  const bindings: TravelingTerseBinding[] = [];

  for (const binding of declared) {
    if (!isTerse(binding.name)) continue;
    if (binding.kind === "loop-variable") continue;
    const declarationLine = lineAt(owner.source, binding.start);
    const relativeDecl = binding.start - fn.start;
    const useLines = useOffsets(functionSource, binding.name)
      .filter((offset) => offset !== relativeDecl)
      .map((offset) => ({
        line: lineAt(owner.source, fn.start + offset),
        absolute: fn.start + offset,
      }));
    if (useLines.length === 0) continue;
    const lastUseLine = Math.max(...useLines.map((use) => use.line));
    const spanLines = lastUseLine - declarationLine;
    if (spanLines <= 1) continue;
    if (binding.kind === "catch-param" && spanLines <= 2) continue;
    const depths = useLines.map((use) =>
      nested.filter((range) => range.start <= use.absolute && use.absolute <= range.end).length
    );
    bindings.push({
      name: binding.name,
      kind: binding.kind,
      declarationLine,
      lastUseLine,
      spanLines,
      uses: useLines.length,
      exposedByExport: binding.kind === "param" && exported,
      capturedAcrossClosure: depths.some((depth) => depth > 0),
      captureDepth: Math.max(...depths),
    });
  }

  if (bindings.length === 0) return undefined;

  return {
    function: {
      name,
      exported,
      filePath: candidate.filePath,
      source: candidate.source,
      startLine,
      endLine: lineAt(owner.source, fn.end),
    },
    bindings: bindings.slice(0, 25),
    functionSpanLines: lineAt(owner.source, fn.end) - startLine,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
