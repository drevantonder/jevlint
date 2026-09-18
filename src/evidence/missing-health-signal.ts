import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Node, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  nestedFunctionRanges,
} from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type {
  FunctionCaller,
  FunctionNode,
  RelatedProjectModule,
} from "./repository.js";

export type ServingSurface = {
  kind: "listen" | "route" | "handler-export";
  expression: string;
};

export type MissingHealthSignalEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  servingSurface: ServingSurface[];
  healthSignals: string[];
  readinessGate: {
    asyncInitBeforeServe: boolean;
    gate: string | null;
  };
  expectedProbe: {
    descriptor: string | null;
    path: string | null;
  };
  siblingHealthSignals: {
    filePath: string;
    excerpt: string;
  }[];
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

const LISTEN_CALL_PATTERN = /^(?:listen|serve|start|startServer|createServer)$/i;
const ROUTE_CALL_PATTERN = /^(?:get|post|put|patch|delete|head|options|all|use|route|register|handler)$/i;
const HEALTH_PATH_PATTERN = /\/healthz?|\/readyz?|\/livez?|\/status/i;
const HEALTH_NAME_PATTERN = /health|readiness|liveness|isReady|isHealthy/i;
const PROBE_DESCRIPTOR_PATTERN = /livenessProbe|readinessProbe|startupProbe|health[_-]?check|HEALTHCHECK/i;
const PROBE_PATH_PATTERN = /path:\s*(\/\S+)|["'](\/(?:health|ready|live|status)[^"']*)["']/i;
const DESCRIPTOR_PATH_PATTERN = /Dockerfile|docker-compose|\.ya?ml$|\.json$|fly\.toml|Procfile/i;

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function finalCalleeName(call: CallExpression): string | null {
  const callee = call.callee.type === "ChainExpression" ? call.callee.expression : call.callee;
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression") {
    if (callee.property.type === "Identifier") return callee.property.name;
    if (callee.property.type === "Literal") return String(callee.property.value);
  }
  return null;
}

function moduleLinesMatching(source: string, pattern: RegExp, limit: number): string[] {
  const result: string[] = [];
  for (const line of source.split("\n")) {
    if (pattern.test(line)) {
      result.push(line.trim().slice(0, 240));
      if (result.length >= limit) break;
    }
  }
  return result;
}

export function buildMissingHealthSignalEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): MissingHealthSignalEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn: FunctionNode | undefined = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const direct = (node: NodeRange): boolean =>
    node.start >= fn.start && node.end <= fn.end && belongsDirectlyToFunction(node, nested);
  const program: Program = parsed.program;
  const source = ownerFile.source;

  const servingSurface: ServingSurface[] = [];
  new Visitor({
    CallExpression(node: CallExpression) {
      if (!direct(node)) return;
      const name = finalCalleeName(node);
      if (!name) return;
      if (LISTEN_CALL_PATTERN.test(name)) {
        servingSurface.push({ kind: "listen", expression: nodeSource(node, source) });
      } else if (ROUTE_CALL_PATTERN.test(name)) {
        servingSurface.push({ kind: "route", expression: nodeSource(node, source) });
      }
    },
  }).visit(program);
  if (servingSurface.length === 0) return undefined;

  const healthSignals = moduleLinesMatching(source, HEALTH_PATH_PATTERN, 8);
  for (const line of moduleLinesMatching(source, HEALTH_NAME_PATTERN, 8)) {
    if (!healthSignals.includes(line)) healthSignals.push(line);
    if (healthSignals.length >= 8) break;
  }

  const initGate = source.search(/await\s+\w+.*\n.*listen|ready\s*=\s*true|isReady\s*=\s*true/i);
  const gateLine = initGate >= 0
    ? source.slice(initGate, source.indexOf("\n", initGate)).trim().slice(0, 240)
    : null;

  let descriptor: string | null = null;
  let probePath: string | null = null;
  for (const file of projectFiles) {
    if (!DESCRIPTOR_PATH_PATTERN.test(file.filePath)) continue;
    if (!PROBE_DESCRIPTOR_PATTERN.test(file.source)) continue;
    const match = PROBE_PATH_PATTERN.exec(file.source);
    descriptor = file.filePath;
    probePath = match?.[1] ?? match?.[2] ?? "(probe declared without a path literal)";
    break;
  }

  const siblingHealthSignals: MissingHealthSignalEvidence["siblingHealthSignals"] = [];
  for (const file of projectFiles) {
    if (file.filePath === candidate.filePath) continue;
    if (!HEALTH_PATH_PATTERN.test(file.source) && !HEALTH_NAME_PATTERN.test(file.source)) continue;
    const lines = moduleLinesMatching(file.source, HEALTH_PATH_PATTERN, 2);
    const excerpt = lines[0] ?? moduleLinesMatching(file.source, HEALTH_NAME_PATTERN, 1)[0];
    if (excerpt) siblingHealthSignals.push({ filePath: file.filePath, excerpt });
    if (siblingHealthSignals.length >= 6) break;
  }

  const name = functionName(program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: source.slice(0, 16_000),
    },
    servingSurface,
    healthSignals,
    readinessGate: {
      asyncInitBeforeServe: gateLine !== null,
      gate: gateLine,
    },
    expectedProbe: { descriptor, path: probePath },
    siblingHealthSignals,
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(candidate.filePath, program, projectFiles),
    },
  };
}
