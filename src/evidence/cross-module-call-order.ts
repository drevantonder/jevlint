import { parseSync, Visitor } from "oxc-parser";
import type { CallExpression, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  calleeRootName,
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  isInsideNestedFunction,
  moduleImports,
  moduleMutableBindings,
  nestedFunctionRanges,
  resolveModule,
} from "./repository.js";
import type { FunctionNode } from "./repository.js";

const MAX_PAIRS = 8;
const MAX_ORDER_SAMPLES = 8;
const MAX_COMBINED = 4;
const MAX_CALL_CHARS = 240;
const MAX_SOURCE_CHARS = 800;

export type CallOrderPair = {
  first: string;
  second: string;
  firstCall: string;
  secondCall: string;
  targetModule: string;
  binding: string;
  guardPresent: boolean;
  combinedEntryPoints: string[];
};

export type CallOrderConvention = {
  first: string;
  second: string;
  targetModule: string;
  orderings: { filePath: string; firstBeforeSecond: boolean }[];
};

export type CrossModuleCallOrderEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  pairs: CallOrderPair[];
  conventions: CallOrderConvention[];
};

type NamedTargetFunction = {
  exportName: string;
  localName: string;
  node: FunctionNode;
};

function targetFunctions(program: Program): NamedTargetFunction[] {
  const result: NamedTargetFunction[] = [];
  const push = (exportName: string, node: FunctionNode, localName?: string): void => {
    if (result.some(({ exportName: existing }) => existing === exportName)) return;
    result.push({ exportName, localName: localName ?? functionName(program, node) ?? exportName, node });
  };
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id) {
      push(declaration.id.name, declaration);
      continue;
    }
    if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (
          item.id.type !== "Identifier"
          || (item.init?.type !== "ArrowFunctionExpression"
            && item.init?.type !== "FunctionExpression")
        ) continue;
        push(item.id.name, item.init);
      }
    }
  }
  return result;
}

function localNames(program: Program, fn: FunctionNode): Set<string> {
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
  new Visitor({
    VariableDeclaration(node) {
      if (node.start < fn.start || node.end > fn.end) return;
      for (const item of node.declarations) {
        if (item.id.type === "Identifier") names.add(item.id.name);
      }
    },
  }).visit(program);
  return names;
}

function writesAndReads(
  program: Program,
  fn: FunctionNode,
  bindings: Set<string>,
) {
  const writes = new Set<string>();
  const reads = new Set<string>();
  const locals = localNames(program, fn);
  new Visitor({
    AssignmentExpression(node) {
      if (node.start < fn.start || node.end > fn.end) return;
      if (node.left.type === "Identifier" && bindings.has(node.left.name) && !locals.has(node.left.name)) {
        writes.add(node.left.name);
      }
    },
    UpdateExpression(node) {
      if (node.start < fn.start || node.end > fn.end) return;
      if (node.argument.type === "Identifier" && bindings.has(node.argument.name) && !locals.has(node.argument.name)) {
        writes.add(node.argument.name);
      }
    },
    Identifier(node) {
      if (node.start < fn.start || node.end > fn.end) return;
      if (bindings.has(node.name) && !locals.has(node.name)) reads.add(node.name);
    },
  }).visit(program);
  for (const name of writes) reads.delete(name);
  return { writes, reads };
}

function callsBoth(program: Program, fn: FunctionNode, firstLocal: string, secondLocal: string): boolean {
  let first = false;
  let second = false;
  new Visitor({
    CallExpression(call) {
      if (call.start < fn.start || call.end > fn.end) return;
      const root = calleeRootName(call.callee);
      if (root === firstLocal) first = true;
      if (root === secondLocal) second = true;
    },
  }).visit(program);
  return first && second;
}

export function buildCrossModuleCallOrderEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): CrossModuleCallOrderEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const imports = moduleImports(parsed.program);
  const byLocal = new Map(imports.map((item) => [item.local, item]));
  const nested = nestedFunctionRanges(parsed.program, candidate);
  const calls: CallExpression[] = [];
  new Visitor({
    CallExpression(call) {
      if (call.start < fn.start || call.end > fn.end) return;
      if (isInsideNestedFunction(call, nested)) return;
      calls.push(call);
    },
  }).visit(parsed.program);
  calls.sort((left, right) => left.start - right.start);

  const ordered: { root: string; imported: string; target: string; call: CallExpression }[] = [];
  for (const call of calls) {
    const root = calleeRootName(call.callee);
    if (!root) continue;
    const imported = byLocal.get(root);
    if (!imported || !imported.source.startsWith(".")) continue;
    const target = resolveModule(owner.filePath, imported.source, projectFiles);
    if (!target || target.filePath === owner.filePath) continue;
    ordered.push({ root, imported: imported.imported, target: target.filePath, call });
  }

  const pairs: CallOrderPair[] = [];
  const conventions: CallOrderConvention[] = [];
  const seen = new Set<string>();
  for (let first = 0; first < ordered.length; first += 1) {
    for (let second = first + 1; second < ordered.length; second += 1) {
      if (pairs.length >= MAX_PAIRS) break;
      const left = ordered[first];
      const right = ordered[second];
      if (!left || !right || left.target !== right.target || left.root === right.root) continue;
      const key = `${left.target}::${left.imported}::${right.imported}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const targetFile = projectFiles.find((file) => file.filePath === left.target);
      if (!targetFile) continue;
      const targetParsed = parseSync(targetFile.filePath, targetFile.source, { range: true });
      if (targetParsed.errors.some((error) => error.severity === "Error")) continue;
      const functions = targetFunctions(targetParsed.program);
      const writer = functions.find(({ exportName }) => exportName === left.imported);
      const reader = functions.find(({ exportName }) => exportName === right.imported);
      if (!writer || !reader) continue;
      const bindings = new Set(moduleMutableBindings(targetParsed.program).map(({ name: binding }) => binding));
      if (bindings.size === 0) continue;
      const writerAccess = writesAndReads(targetParsed.program, writer.node, bindings);
      const readerAccess = writesAndReads(targetParsed.program, reader.node, bindings);
      const shared = [...writerAccess.writes].filter((binding) => readerAccess.reads.has(binding));
      if (shared.length === 0) continue;

      const readerSource = targetFile.source.slice(reader.node.start, reader.node.end);
      const combined = functions
        .filter(({ exportName }) => exportName !== left.imported && exportName !== right.imported)
        .filter(({ node }) => callsBoth(targetParsed.program, node, writer.localName, reader.localName))
        .map(({ exportName }) => exportName)
        .slice(0, MAX_COMBINED);

      pairs.push({
        first: left.root,
        second: right.root,
        firstCall: owner.source.slice(left.call.start, left.call.end).slice(0, MAX_CALL_CHARS),
        secondCall: owner.source.slice(right.call.start, right.call.end).slice(0, MAX_CALL_CHARS),
        targetModule: left.target,
        binding: shared[0] ?? "unknown",
        guardPresent: readerSource.includes("throw"),
        combinedEntryPoints: combined,
      });

      const writerCallers = findFunctionCallers(left.target, left.imported, projectFiles);
      const readerLines = new Map<string, number>();
      for (const caller of findFunctionCallers(left.target, right.imported, projectFiles)) {
        if (!readerLines.has(caller.filePath)) readerLines.set(caller.filePath, caller.line);
      }
      const orderings: CallOrderConvention["orderings"] = [];
      for (const caller of writerCallers) {
        if (orderings.length >= MAX_ORDER_SAMPLES) break;
        const readerLine = readerLines.get(caller.filePath);
        if (readerLine === undefined || readerLine === caller.line) continue;
        if (orderings.some(({ filePath }) => filePath === caller.filePath)) continue;
        orderings.push({ filePath: caller.filePath, firstBeforeSecond: caller.line < readerLine });
      }
      conventions.push({
        first: left.root,
        second: right.root,
        targetModule: left.target,
        orderings,
      });
    }
    if (pairs.length >= MAX_PAIRS) break;
  }
  if (pairs.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source.slice(0, MAX_SOURCE_CHARS),
    },
    pairs,
    conventions,
  };
}
