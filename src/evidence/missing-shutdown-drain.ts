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

export type ShutdownDrainEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  bootstrapCalls: string[];
  shutdown: {
    closeCalls: string[];
    signalHandlers: string[];
    drainWaits: string[];
    connectionTracking: string | null;
    unreadyBeforeClose: boolean;
  };
  orchestratorManaged: {
    descriptor: string | null;
    excerpt: string | null;
  };
  siblingDrainHandlers: {
    filePath: string;
    excerpt: string;
  }[];
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

const BOOTSTRAP_CALL_PATTERN = /^(?:listen|serve|start|startServer|createServer|serveHttp)$/i;
const CLOSE_CALL_PATTERN = /^(?:close|shutdown|closeServer|stop|dispose|terminate)$/i;
const DRAIN_PATTERN = /allConnections|getConnections|trackedSockets|openSockets|pendingRequests|inflight|inFlight|activeRequests|await.*close|close.*await/i;
const TRACKING_PATTERN = /allConnections|trackedSockets|openSockets|pendingRequests|activeRequests/i;
const UNREADY_PATTERN = /unready|draining|terminating|ready\s*=\s*false|isShuttingDown/i;
const DESCRIPTOR_PATH_PATTERN = /Dockerfile|docker-compose|\.k8s\.|\/k8s\/|deployment|manifest|Procfile|fly\.toml|railway/i;
const DESCRIPTOR_SIGNAL_PATTERN = /SIGTERM|livenessProbe|readinessProbe|prestop|preStop|kill_signal|stop_signal/i;

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

function moduleLineMatching(source: string, pattern: RegExp): string | null {
  for (const line of source.split("\n")) {
    if (pattern.test(line)) return line.trim().slice(0, 240);
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

export function buildMissingShutdownDrainEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ShutdownDrainEvidence | undefined {
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

  const bootstrapCalls: string[] = [];
  const closeCalls: string[] = [];
  new Visitor({
    CallExpression(node: CallExpression) {
      if (node.start < fn.start || node.end > fn.end) return;
      const name = finalCalleeName(node);
      if (!name) return;
      if (BOOTSTRAP_CALL_PATTERN.test(name) && direct(node)) {
        bootstrapCalls.push(nodeSource(node, source));
      }
      if (CLOSE_CALL_PATTERN.test(name)) closeCalls.push(nodeSource(node, source));
    },
  }).visit(program);
  if (bootstrapCalls.length === 0) return undefined;

  const signalHandlers = moduleLinesMatching(source, /process\.on\(\s*["']SIG(?:TERM|INT)["']/, 6);
  const drainWaits = moduleLinesMatching(source, DRAIN_PATTERN, 8);

  let descriptor: string | null = null;
  let excerpt: string | null = null;
  for (const file of projectFiles) {
    if (!DESCRIPTOR_PATH_PATTERN.test(file.filePath)) continue;
    const match = moduleLineMatching(file.source, DESCRIPTOR_SIGNAL_PATTERN)
      ?? (/(?:CMD|ENTRYPOINT|image:|app:)/.test(file.source)
        ? file.source.split("\n").slice(0, 4).join("\n").slice(0, 240)
        : null);
    if (match) {
      descriptor = file.filePath;
      excerpt = match;
      break;
    }
  }

  const siblingDrainHandlers: ShutdownDrainEvidence["siblingDrainHandlers"] = [];
  for (const file of projectFiles) {
    if (file.filePath === candidate.filePath) continue;
    if (!/SIGTERM|SIGINT/.test(file.source)) continue;
    const line = moduleLineMatching(file.source, /SIGTERM|SIGINT/);
    if (line) siblingDrainHandlers.push({ filePath: file.filePath, excerpt: line });
    if (siblingDrainHandlers.length >= 6) break;
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
    bootstrapCalls,
    shutdown: {
      closeCalls,
      signalHandlers,
      drainWaits,
      connectionTracking: moduleLineMatching(source, TRACKING_PATTERN),
      unreadyBeforeClose: UNREADY_PATTERN.test(source),
    },
    orchestratorManaged: { descriptor, excerpt },
    siblingDrainHandlers,
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(candidate.filePath, program, projectFiles),
    },
  };
}
