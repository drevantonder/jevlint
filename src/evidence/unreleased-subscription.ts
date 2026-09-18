import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression } from "oxc-parser";
import type { Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  isInsideNestedFunction,
  moduleImports,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

const ACQUIRE_METHODS = new Set([
  "addEventListener",
  "on",
  "subscribe",
  "listen",
  "setInterval",
]);

const RELEASE_PATTERN = /removeEventListener|\boff\s*\(|removeListener|unsubscribe|\bclose\s*\(|clearInterval|AbortSignal|\.abort\s*\(/g;
const EFFECT_CLEANUP_PATTERN = /return\s+(?:async\s+)?(?:\(\)|[A-Za-z_$][\w$]*)\s*=>|return\s+function\s*\(|return\s+[A-Za-z_$][\w$]*\s*;/;
const OWNER_HINT_PATTERN = /handler|handle|effect|subscri|listen|mount|route|controller|request|render|component/i;
const REQUEST_PARAM_PATTERN = /\b(req|request|res|response|ctx|context|event|message)\b/i;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

export type SubscriptionAcquisition = {
  kind: string;
  call: string;
  line: number;
};

export type UnreleasedSubscriptionEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  acquisitions: SubscriptionAcquisition[];
  removalsInModule: string[];
  hasEffectCleanupReturn: boolean;
  cleanupReturn: string | null;
  ownerLifetime: {
    nameHints: string[];
    hasRequestParameters: boolean;
    frameworkEffectImport: boolean;
  };
  callers: FunctionCaller[];
};

function acquireKind(call: CallExpression): string | undefined {
  const callee = call.callee.type === "ChainExpression" ? call.callee.expression : call.callee;
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
    return ACQUIRE_METHODS.has(callee.property.name) ? callee.property.name : undefined;
  }
  if (callee.type === "Identifier" && ACQUIRE_METHODS.has(callee.name)) return callee.name;
  return undefined;
}

export function buildUnreleasedSubscriptionEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnreleasedSubscriptionEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nestedFunctions = nestedFunctionRanges(parsed.program, candidate);
  const inScope = (node: Node): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !isInsideNestedFunction(node, nestedFunctions);

  const acquisitions: SubscriptionAcquisition[] = [];
  new Visitor({
    CallExpression(node) {
      if (!inScope(node)) return;
      const kind = acquireKind(node);
      if (!kind) return;
      acquisitions.push({
        kind,
        call: owner.source.slice(node.start, node.end).slice(0, 300),
        line: lineAt(owner.source, node.start),
      });
    },
  }).visit(parsed.program);
  if (acquisitions.length === 0) return undefined;

  const removalsInModule = [...owner.source.matchAll(RELEASE_PATTERN)].map((match) =>
    match[0].slice(0, 60),
  ).slice(0, 10);

  const functionText = owner.source.slice(candidate.start, candidate.end);
  const cleanupMatch = EFFECT_CLEANUP_PATTERN.exec(functionText);

  const parameters = fn.params.map((parameter) =>
    owner.source.slice(parameter.start, parameter.end),
  );
  const nameHints = [name, candidate.filePath].filter((text) => OWNER_HINT_PATTERN.test(text));
  const imports = moduleImports(parsed.program);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    acquisitions,
    removalsInModule,
    hasEffectCleanupReturn: cleanupMatch !== null,
    cleanupReturn: cleanupMatch ? cleanupMatch[0].slice(0, 120) : null,
    ownerLifetime: {
      nameHints,
      hasRequestParameters: parameters.some((parameter) => REQUEST_PARAM_PATTERN.test(parameter)),
      frameworkEffectImport: imports.some(({ source, local }) =>
        /react|vue|svelte|solid|angular|rxjs/i.test(source) || /useEffect|onMount|watch/i.test(local),
      ),
    },
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
