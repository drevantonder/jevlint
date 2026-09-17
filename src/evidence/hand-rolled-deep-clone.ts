import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type HandRolledDeepCloneEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  jsonRoundTrip: string | null;
  recursiveClone: boolean;
  typeBranches: string[];
  justification: {
    preservesPrototypeOrClass: boolean;
    preservesFunctions: boolean;
    hasReviverOrCustomizer: boolean;
    lossyTradeoffComment: boolean;
  };
  callers: FunctionCaller[];
};

const TYPE_BRANCH_PATTERN =
  /\binstanceof\s+(Date|Map|Set|RegExp|ArrayBuffer|DataView)\b|Array\.isArray\s*\(|\btypeof\s+\w+\s*===?\s*["'](object|function)["']/g;

const PRESERVATION_PATTERN =
  /\bprototype\b|\bconstructor\b|\bgetPrototypeOf\b|\bcreate\s*\(|__proto__|new\s+(this|self|target\.constructor|value\.constructor)/;
const FUNCTION_PRESERVATION_PATTERN = /\btypeof\s+\w+\s*===?\s*["']function["']|\binstanceof\s+Function\b/;
const REVIVER_PATTERN = /\breviver\b|\bcustomizer\b|\bcloneFunc\b|\bcustomClone\b/;
const LOSSY_COMMENT_PATTERN = /lossy|serializable|plain (old |data|json)|json-safe|structuredClone|no (Date|Map|Set|class|function)/i;

export function buildHandRolledDeepCloneEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HandRolledDeepCloneEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const nested = nestedFunctionRanges(parsed.program, fn);
  const source = owner.source;
  const functionText = source.slice(candidate.start, candidate.end);

  let jsonRoundTrip: string | null = null;
  new Visitor({
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested) || jsonRoundTrip) return;
      const text = source.slice(call.start, call.end);
      if (/JSON\.parse\s*\(\s*JSON\.stringify\s*\(/.test(text)) {
        jsonRoundTrip = text.slice(0, 300);
      }
    },
  }).visit(parsed.program);

  const name = functionName(parsed.program, fn);
  const selfCall = name
    ? new RegExp(`\\b${name}\\s*\\(`).test(functionText.replace(/^[^]*?\{/, ""))
    : false;
  const typeBranches = [...functionText.matchAll(TYPE_BRANCH_PATTERN)]
    .map((match) => match[0].slice(0, 60))
    .slice(0, 10);
  const recursiveClone = selfCall || typeBranches.length >= 2;

  if (!jsonRoundTrip && !recursiveClone) return undefined;

  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    jsonRoundTrip,
    recursiveClone,
    typeBranches,
    justification: {
      preservesPrototypeOrClass: PRESERVATION_PATTERN.test(functionText),
      preservesFunctions: FUNCTION_PRESERVATION_PATTERN.test(functionText),
      hasReviverOrCustomizer: REVIVER_PATTERN.test(functionText),
      lossyTradeoffComment: LOSSY_COMMENT_PATTERN.test(functionText),
    },
    callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
  };
}
