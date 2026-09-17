import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { containsNode } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type HandRolledFlattenEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  selfRecursive: boolean;
  concatSignals: string[];
  depthParameter: string | null;
  justification: {
    depthCapWithMeaning: boolean;
    holeHandling: boolean;
    lazyIteration: boolean;
  };
  callers: FunctionCaller[];
};

const CONCAT_PATTERN = /\.concat\s*\(|\.push\s*\(\s*\.\.\.|\[\s*\.\.\.\w+\s*,\s*\.\.\./g;
const DEPTH_PARAM_PATTERN = /\b(depth|level|maxDepth)\b/;
const DEPTH_MEANING_PATTERN = /depth\s*(===?|!==?|<=?|>=?)\s*\d|MAX_|maxDepth|levels?\.length|nesting/i;
const HOLE_PATTERN = /\bholes?\b|\bsparse\b|\bin\b\s+\w+|hasOwnProperty|delete\s+\w+\[|length\s*=\s*\d+/i;
const LAZY_PATTERN = /function\s*\*|\byield\b|Symbol\.iterator|next\s*\(\s*\)|generator/i;

export function buildHandRolledFlattenEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HandRolledFlattenEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const source = owner.source;
  const functionText = source.slice(candidate.start, candidate.end);

  const name = functionName(parsed.program, fn);
  let selfRecursive = false;
  new Visitor({
    CallExpression(call) {
      if (!containsNode(fn, call) || selfRecursive) return;
      const callee = call.callee.type === "ChainExpression" ? call.callee.expression : call.callee;
      if (name && callee.type === "Identifier" && callee.name === name) selfRecursive = true;
    },
  }).visit(parsed.program);

  const concatSignals = [...functionText.matchAll(CONCAT_PATTERN)]
    .map((match) => match[0].slice(0, 40))
    .slice(0, 10);
  const hasArrayCheck = /Array\.isArray\s*\(/.test(functionText);
  if (!hasArrayCheck || concatSignals.length === 0) return undefined;
  if (!selfRecursive) {
    const depthMatch = DEPTH_PARAM_PATTERN.exec(functionText);
    if (!depthMatch) return undefined;
  }

  const paramsText = functionText.slice(0, functionText.indexOf("{") + 1);
  const depthParameter = DEPTH_PARAM_PATTERN.exec(paramsText)?.[0] ?? null;

  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    selfRecursive,
    concatSignals,
    depthParameter,
    justification: {
      depthCapWithMeaning: DEPTH_MEANING_PATTERN.test(functionText),
      holeHandling: HOLE_PATTERN.test(functionText),
      lazyIteration: LAZY_PATTERN.test(functionText),
    },
    callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
  };
}
