import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type LocaleDateSerializationEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  serializations: string[];
  hasBoundarySink: boolean;
  hasIsoForm: boolean;
  siblingIsoSerialization: boolean;
  callers: FunctionCaller[];
};

const LOCALE_METHODS = new Set([
  "toLocaleString",
  "toLocaleDateString",
  "toLocaleTimeString",
  "toDateString",
  "toTimeString",
]);

const SINK_TOKEN = /\b(fetch|axios|prisma|db\.|save|insert|persist|res\.json|res\.send|response\.json|publish|sendMessage|enqueue|queue|localStorage|knex|drizzle|typeorm)\b/;

export function buildLocaleDateSerializationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): LocaleDateSerializationEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const serializations: string[] = [];

  const push = (node: { start: number; end: number }): void => {
    if (serializations.length < 20) {
      serializations.push(owner.source.slice(node.start, node.end).slice(0, 240));
    }
  };

  let functionDepth = 0;
  const isDirect = (node: FunctionNode): boolean => node.start === fn.start && node.end === fn.end;
  const enterFunction = (node: FunctionNode): void => {
    if (isDirect(node)) functionDepth = 1;
    else if (functionDepth > 0) functionDepth += 1;
  };
  const exitFunction = (node: FunctionNode): void => {
    if (functionDepth === 0) return;
    functionDepth -= 1;
    if (isDirect(node)) functionDepth = 0;
  };

  new Visitor({
    ArrowFunctionExpression: enterFunction,
    "ArrowFunctionExpression:exit": exitFunction,
    FunctionDeclaration: enterFunction,
    "FunctionDeclaration:exit": exitFunction,
    FunctionExpression: enterFunction,
    "FunctionExpression:exit": exitFunction,
    CallExpression(node) {
      if (functionDepth !== 1) return;
      const callee = node.callee.type === "ChainExpression" ? node.callee.expression : node.callee;
      if (callee.type !== "MemberExpression" || callee.computed) return;
      if (callee.property.type !== "Identifier") return;
      if (!LOCALE_METHODS.has(callee.property.name)) return;
      push(node);
    },
  }).visit(parsed.program);

  if (serializations.length === 0) {
    const body = owner.source.slice(fn.start, fn.end);
    if (!/\.toString\(\)/.test(body) || !/\b(date|Date|time|timestamp|createdAt|updatedAt)\b/i.test(body)) {
      return undefined;
    }
    serializations.push(body.slice(0, 240));
  }

  const body = owner.source.slice(fn.start, fn.end);
  const hasBoundarySink = SINK_TOKEN.test(body);
  const hasIsoForm = /toISOString|\.getTime\(\)|Date\.now|\.valueOf\(\)/.test(body);

  let siblingIsoSerialization = false;
  for (const file of projectFiles) {
    if (file.filePath === owner.filePath) continue;
    if (file.source.includes("toISOString")) {
      siblingIsoSerialization = true;
      break;
    }
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    serializations,
    hasBoundarySink,
    hasIsoForm,
    siblingIsoSerialization,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
