import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { dirOf, inferLayer } from "./module.js";
import {
  calleeRootName,
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  isInsideNestedFunction,
  moduleImports,
  nestedFunctionRanges,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

const MAX_TARGETS = 6;
const MAX_INTERMEDIARIES = 4;
const MAX_GUARD_EXCERPTS = 6;
const MAX_CALLER_SAMPLES = 5;
const MAX_CALL_CHARS = 240;
const MAX_EXCERPT_CHARS = 160;

const GUARD_LINE_PATTERN = /\b(throw|assert|authorize|authorise|authenticate|validate|permit|deny|forbid|check[A-Z_])\b/;

export type LayerSkippingBypass = {
  call: string;
  callee: string;
  importedFrom: string;
  importPreExists: boolean;
  targetModule: string;
  targetLayer: string;
  intermediary: {
    filePath: string;
    layer: string;
    guardExcerpts: { line: number; text: string }[];
    targetCallerTotal: number;
    targetCallerSample: FunctionCaller[];
  }[];
};

export type LayerSkippingCallEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  callerLayer: string;
  bypasses: LayerSkippingBypass[];
};

function previousSpecifiers(filePath: string, oldSource: string | null): Set<string> | undefined {
  if (oldSource === null) return new Set();
  const parsed = parseCached(filePath, oldSource);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  return new Set(moduleImports(parsed.program).map((item) => item.source));
}

function guardExcerpts(source: string): { line: number; text: string }[] {
  const excerpts: { line: number; text: string }[] = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (excerpts.length >= MAX_GUARD_EXCERPTS) break;
    const line = lines[index] ?? "";
    if (!GUARD_LINE_PATTERN.test(line)) continue;
    excerpts.push({ line: index + 1, text: line.trim().slice(0, MAX_EXCERPT_CHARS) });
  }
  return excerpts;
}

export function buildLayerSkippingCallEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): LayerSkippingCallEvidence | undefined {
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
  if (calls.length === 0) return undefined;

  const change = changes.find((item) => item.filePath === candidate.filePath);
  const previous = change ? previousSpecifiers(candidate.filePath, change.oldSource) : new Set<string>();

  const seenTargets = new Set<string>();
  const bypasses: LayerSkippingBypass[] = [];
  for (const call of calls) {
    if (bypasses.length >= MAX_TARGETS) break;
    const root = calleeRootName(call.callee);
    if (!root) continue;
    const imported = byLocal.get(root);
    if (!imported || !imported.source.startsWith(".")) continue;
    const target = resolveModule(owner.filePath, imported.source, projectFiles);
    if (!target || target.filePath === owner.filePath) continue;
    if (seenTargets.has(target.filePath)) continue;
    seenTargets.add(target.filePath);

    const intermediaries: LayerSkippingBypass["intermediary"] = [];
    for (const edge of imports) {
      if (intermediaries.length >= MAX_INTERMEDIARIES) break;
      if (!edge.source.startsWith(".")) continue;
      const middle = resolveModule(owner.filePath, edge.source, projectFiles);
      if (!middle || middle.filePath === owner.filePath || middle.filePath === target.filePath) continue;
      const middleParsed = parseCached(middle.filePath, middle.source);
      if (middleParsed.errors.some((error) => error.severity === "Error")) continue;
      const reachesTarget = moduleImports(middleParsed.program).some((item) =>
        item.source.startsWith(".")
        && resolveModule(middle.filePath, item.source, projectFiles)?.filePath === target.filePath
      );
      if (!reachesTarget) continue;
      const targetCallers = findFunctionCallers(target.filePath, imported.imported, projectFiles);
      intermediaries.push({
        filePath: middle.filePath,
        layer: inferLayer(dirOf(middle.filePath)).inferredRole,
        guardExcerpts: guardExcerpts(middle.source),
        targetCallerTotal: targetCallers.length,
        targetCallerSample: targetCallers.slice(0, MAX_CALLER_SAMPLES),
      });
    }
    if (intermediaries.length === 0) continue;
    bypasses.push({
      call: owner.source.slice(call.start, call.end).slice(0, MAX_CALL_CHARS),
      callee: root,
      importedFrom: imported.source,
      importPreExists: previous?.has(imported.source) ?? false,
      targetModule: target.filePath,
      targetLayer: inferLayer(dirOf(target.filePath)).inferredRole,
      intermediary: intermediaries,
    });
  }
  if (bypasses.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    callerLayer: inferLayer(dirOf(candidate.filePath)).inferredRole,
    bypasses,
  };
}
