import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller, RelatedProjectModule } from "./repository.js";

export type BlockingSinkKind = "sync-call" | "serialization" | "regex-test";

export type BlockingCall = {
  source: string;
  callee: string;
  kind: BlockingSinkKind;
  line: number;
};

export type BlockingEventLoopCallEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  blockingCalls: BlockingCall[];
  servingContext: {
    handlerHints: string[];
    scriptHints: string[];
  };
  mitigation: {
    workerImport: boolean;
    workerUsage: boolean;
    asyncVariants: string[];
    sizeCapPresent: boolean;
  };
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

const HANDLER_HINT_PATTERN = /handler|handle|route|controller|middleware|server|endpoint|request|listen/i;
const SCRIPT_HINT_PATTERN = /script|build|cli|migrate|seed|bin|setup/i;
const WORKER_IMPORT_PATTERN = /worker_threads|piscina|workerpool|tiny-worker/i;
const WORKER_USAGE_PATTERN = /new\s+Worker\s*\(|worker_threads|postMessage/;
const SIZE_CAP_PATTERN = /slice\s*\(|MAX_|LIMIT|CHUNK|batchSize|pageSize|highWaterMark/i;

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function shortName(callee: string): string {
  const match = /([A-Za-z_$][\w$]*)\s*$/.exec(callee);
  return match?.[1] ?? callee;
}

function blockingKind(call: CallExpression): BlockingSinkKind | undefined {
  const callee = call.callee.type === "ChainExpression" ? call.callee.expression : call.callee;
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
    const method = callee.property.name;
    if (method.endsWith("Sync")) return "sync-call";
    if (
      callee.object.type === "Identifier"
      && callee.object.name === "JSON"
      && (method === "parse" || method === "stringify")
    ) return "serialization";
    if (method === "test" || method === "exec") return "regex-test";
    return undefined;
  }
  if (callee.type === "Identifier" && callee.name.endsWith("Sync")) return "sync-call";
  return undefined;
}

export function buildBlockingEventLoopCallEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): BlockingEventLoopCallEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const nested = nestedFunctionRanges(parsed.program, fn);
  const source = ownerFile.source;

  const blockingCalls: BlockingCall[] = [];
  new Visitor({
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      const kind = blockingKind(call);
      if (!kind) return;
      const callee = nodeSource(call.callee, source);
      blockingCalls.push({
        source: nodeSource(call, source),
        callee,
        kind,
        line: lineAt(source, call.start),
      });
    },
  }).visit(parsed.program);
  if (blockingCalls.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  const nameAndPath = [name ?? "", candidate.filePath];
  const servingContext = {
    handlerHints: nameAndPath.filter((text) => HANDLER_HINT_PATTERN.test(text)),
    scriptHints: nameAndPath.filter((text) => SCRIPT_HINT_PATTERN.test(text)),
  };

  const imports = moduleImports(parsed.program);
  const functionSource = source.slice(candidate.start, candidate.end);
  const asyncVariants = [...new Set(blockingCalls.flatMap(({ callee, kind }) => {
    if (kind !== "sync-call") return [];
    const base = shortName(callee).replace(/Sync$/, "");
    if (!base || new RegExp(`\\b${base}\\s*\\(`).test(source)) return [base];
    return [];
  }))];

  const nameForExport = name ?? null;
  return {
    function: {
      name: nameForExport,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: source.slice(0, 16_000),
    },
    blockingCalls,
    servingContext,
    mitigation: {
      workerImport: imports.some(({ source: specifier }) => WORKER_IMPORT_PATTERN.test(specifier)),
      workerUsage: WORKER_USAGE_PATTERN.test(source),
      asyncVariants,
      sizeCapPresent: SIZE_CAP_PATTERN.test(functionSource),
    },
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(candidate.filePath, parsed.program, projectFiles),
    },
  };
}
