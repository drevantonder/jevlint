import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, RelatedProjectModule } from "./repository.js";

const SUBSTRING_METHODS = new Set(["indexOf", "includes", "startsWith", "endsWith"]);
const HOST_PATTERN = /host|origin|referer|domain|allow|white|trust|callback/i;

export type DomainCheck = {
  source: string;
  method: string;
  anchored: boolean;
  dotBoundary: boolean;
  hostLike: boolean;
};

export type UnanchoredDomainCheckEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  checks: DomainCheck[];
  urlParsed: boolean;
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function methodName(call: CallExpression): string | null {
  if (call.callee.type === "MemberExpression" && call.callee.property.type === "Identifier") {
    return call.callee.property.name;
  }
  if (call.callee.type === "Identifier") return call.callee.name;
  return null;
}

type RegexAnchoring = {
  anchored: boolean;
  dotBoundary: boolean;
};

function regexAnchored(pattern: string): RegexAnchoring {
  const anchored = pattern.startsWith("^") || pattern.endsWith("$");
  const dotBoundary = /\\\.\s*\\b|\\\.\(\?|\(\?:?\s*\\\.\)|\[\^.\]/.test(pattern)
    || pattern.includes("\\.");
  return { anchored, dotBoundary };
}

export function buildUnanchoredDomainCheckEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnanchoredDomainCheckEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const functionSource = ownerFile.source.slice(fn.start, fn.end);
  const urlParsed = /new\s+URL\s*\(/.test(functionSource);
  const checks: DomainCheck[] = [];

  new Visitor({
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      const name = methodName(call);
      if (!name) return;
      const text = nodeSource(call, ownerFile.source);
      if (SUBSTRING_METHODS.has(name)) {
        const hostLike = HOST_PATTERN.test(text);
        if (!hostLike) return;
        const dotBoundary = /["'`]\s*\./.test(text) || /\.\s*["'`]/.test(text);
        checks.push({
          source: text,
          method: name,
          anchored: false,
          dotBoundary,
          hostLike,
        });
        return;
      }
      if (name === "test" || name === "match") {
        if (!HOST_PATTERN.test(text)) return;
        const pattern = /\/((?:[^/\\]|\\.)+)\/[a-z]*/.exec(text)?.[1] ?? "";
        const { anchored, dotBoundary } = regexAnchored(pattern);
        checks.push({
          source: text,
          method: name,
          anchored,
          dotBoundary,
          hostLike: true,
        });
      }
    },
  }).visit(parsed.program);

  if (checks.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    checks,
    urlParsed,
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(candidate.filePath, parsed.program, projectFiles),
    },
  };
}
