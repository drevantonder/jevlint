import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type HandRolledGroupByEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  groupingLoop: string | null;
  accumulatorWrites: string[];
  keyNormalization: string[];
  justification: {
    usesMapWithIdentity: boolean;
    compositeKey: boolean;
    targetConstraintComment: boolean;
  };
  callers: FunctionCaller[];
};

const LOOP_METHODS = new Set(["reduce", "forEach"]);

const MAP_PATTERN = /new\s+Map\s*(<[^>]*>)?\s*\(/;
const KEY_NORMALIZATION_PATTERN =
  /\bString\s*\(|\.toLowerCase\s*\(|\.toUpperCase\s*\(|JSON\.stringify\s*\(|\.toISOString\s*\(|\.getTime\s*\(/g;

const COMPOSITE_KEY_PATTERN = /[`+]\s*["'`|/#:-]|["'`|/#:-]\s*[`+]|\+ *["'`]|`[^`]*\$\{/;

const TARGET_COMMENT_PATTERN = /es20(1\d|2[0-3])\b|legacy (target|engine|browser)|polyfill|node (1[0-5]|12|14|16)\b|IE\b|internet explorer/i;

function loopKind(call: CallExpression): string | undefined {
  const callee = call.callee.type === "ChainExpression" ? call.callee.expression : call.callee;
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
    return LOOP_METHODS.has(callee.property.name) ? callee.property.name : undefined;
  }
  return undefined;
}

function accumulatorWrite(statementText: string): boolean {
  const keyedWrite = statementText
    .split("\n")
    .filter((line) => !/^\s*(const|let|var|type|interface|import|export)\b/.test(line))
    .some((line) => /\[.+\]\s*(\?\?=|\|\|=|=)/.test(line));
  return keyedWrite || (MAP_PATTERN.test(statementText) && /\.set\s*\(/.test(statementText));
}

export function buildHandRolledGroupByEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HandRolledGroupByEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const nested = nestedFunctionRanges(parsed.program, fn);
  const source = owner.source;

  let groupingLoop: string | null = null;
  new Visitor({
    ForStatement(node) {
      if (containsNode(fn, node) && belongsDirectlyToFunction(node, nested) && !groupingLoop) {
        groupingLoop = source.slice(node.start, node.end).slice(0, 200);
      }
    },
    ForOfStatement(node) {
      if (containsNode(fn, node) && belongsDirectlyToFunction(node, nested) && !groupingLoop) {
        groupingLoop = source.slice(node.start, node.end).slice(0, 200);
      }
    },
    ForInStatement(node) {
      if (containsNode(fn, node) && belongsDirectlyToFunction(node, nested) && !groupingLoop) {
        groupingLoop = source.slice(node.start, node.end).slice(0, 200);
      }
    },
    WhileStatement(node) {
      if (containsNode(fn, node) && belongsDirectlyToFunction(node, nested) && !groupingLoop) {
        groupingLoop = source.slice(node.start, node.end).slice(0, 200);
      }
    },
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested) || groupingLoop) return;
      const kind = loopKind(call);
      if (kind) groupingLoop = source.slice(call.start, call.end).slice(0, 200);
    },
  }).visit(parsed.program);
  if (!groupingLoop) return undefined;

  const functionText = source.slice(candidate.start, candidate.end);
  const accumulatorWrites = functionText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      (/\[.+\]\s*(\?\?=|\|\|=|=)/.test(line) || /\.push\s*\(/.test(line))
      && line.length > 0
    )
    .map((line) => line.slice(0, 160))
    .slice(0, 10);
  if (!accumulatorWrite(functionText)) return undefined;
  if (accumulatorWrites.length === 0) return undefined;

  const keyNormalization = [...functionText.matchAll(KEY_NORMALIZATION_PATTERN)]
    .map((match) => match[0].slice(0, 60))
    .slice(0, 10);

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    groupingLoop,
    accumulatorWrites,
    keyNormalization,
    justification: {
      usesMapWithIdentity: MAP_PATTERN.test(functionText),
      compositeKey: COMPOSITE_KEY_PATTERN.test(functionText),
      targetConstraintComment: TARGET_COMMENT_PATTERN.test(functionText),
    },
    callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
  };
}
