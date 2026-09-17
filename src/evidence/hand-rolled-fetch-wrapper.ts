import { parseSync } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type HandRolledFetchWrapperEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  transportImport: string;
  requestAssembly: string[];
  chunkHandling: string[];
  transportOptions: string[];
  jsonHelper: boolean;
  callers: FunctionCaller[];
};

const TRANSPORT_IMPORT_PATTERN = /^node:(http|https)$/;
const REQUEST_PATTERNS: Array<[RegExp, string]> = [
  [/\.(request|get)\s*\(/, "request-call"],
  [/statusCode/, "status-branching"],
  [/\.write\s*\(|\.end\s*\(/, "body-write"],
];
const CHUNK_PATTERNS: Array<[RegExp, string]> = [
  [/\.on\s*\(\s*["']data["']/, "data-listener"],
  [/Buffer\s*\.\s*concat|chunks/, "chunk-concat"],
  [/\.on\s*\(\s*["']end["']/, "end-listener"],
];
const TRANSPORT_OPTION_PATTERNS: Array<[RegExp, string]> = [
  [/\bproxy\b/i, "proxy"],
  [/\bagent\b\s*:|Agent\b/, "agent"],
  [/\bsocket\b/i, "socket"],
  [/\.pipe\s*\(|backpressure/i, "streaming"],
  [/keepAlive|keep-alive/i, "keep-alive"],
];

export function buildHandRolledFetchWrapperEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HandRolledFetchWrapperEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const transportImport = moduleImports(parsed.program)
    .map(({ source }) => source)
    .find((source) => TRANSPORT_IMPORT_PATTERN.test(source));
  if (!transportImport) return undefined;

  const requestAssembly = REQUEST_PATTERNS
    .filter(([pattern]) => pattern.test(candidate.source))
    .map(([, label]) => label);
  if (!requestAssembly.includes("request-call")) return undefined;

  const chunkHandling = CHUNK_PATTERNS
    .filter(([pattern]) => pattern.test(candidate.source))
    .map(([, label]) => label);
  if (chunkHandling.length === 0) return undefined;

  const transportOptions = TRANSPORT_OPTION_PATTERNS
    .filter(([pattern]) => pattern.test(candidate.source))
    .map(([, label]) => label);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    transportImport,
    requestAssembly,
    chunkHandling,
    transportOptions,
    jsonHelper: /JSON\s*\.\s*parse|application\/json|Content-Type/i.test(candidate.source),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
