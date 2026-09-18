import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type TimerKind = "setInterval" | "setTimeout" | "setImmediate";

export type OrphanedTimer = {
  source: string;
  kind: TimerKind;
  repeating: boolean;
  storedAs: string | null;
  cleared: boolean;
  clearEvidence: string | null;
  line: number;
};

export type OrphanedTimerEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  timers: OrphanedTimer[];
  teardown: {
    present: boolean;
    names: string[];
    clearsTimer: boolean;
  };
  ownerLifetime: {
    handlerHints: string[];
    hasRequestParameters: boolean;
    repeatedCreation: boolean;
  };
  moduleReleases: string[];
  callers: FunctionCaller[];
};

const TEARDOWN_NAME_PATTERN = /dispose|close|unmount|cleanup|teardown|destroy|stop|cancel|disconnect|unsubscribe/i;
const RELEASE_PATTERN = /clearInterval|clearTimeout|clearImmediate|\.unref\s*\(|unref\s*\(/g;
const HANDLER_HINT_PATTERN = /handler|handle|route|controller|request|render|component|mount|effect|subscri|listen/i;
const REQUEST_PARAM_PATTERN = /\b(req|request|res|response|ctx|context|event|props|message)\b/i;

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

function timerKind(call: CallExpression): TimerKind | undefined {
  const callee = call.callee.type === "ChainExpression" ? call.callee.expression : call.callee;
  const method = callee.type === "MemberExpression" && callee.property.type === "Identifier"
    ? callee.property.name
    : callee.type === "Identifier"
      ? callee.name
      : undefined;
  if (method === "setInterval") return "setInterval";
  if (method === "setTimeout") return "setTimeout";
  if (method === "setImmediate") return "setImmediate";
  return undefined;
}

function clearEvidenceFor(handle: string, source: string): string | null {
  const patterns = [
    new RegExp(`clear(?:Interval|Timeout|Immediate)\\s*\\(\\s*${handle}\\b`),
    new RegExp(`\\b${handle}\\s*\\.\\s*unref\\s*\\(`),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match) return match[0].slice(0, 80);
  }
  return null;
}

export function buildOrphanedTimerEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): OrphanedTimerEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const nested = nestedFunctionRanges(parsed.program, fn);
  const source = owner.source;

  const inScope = (node: Node): boolean =>
    containsNode(fn, node) && belongsDirectlyToFunction(node, nested);

  const bindings = new Map<string, CallExpression>();
  new Visitor({
    VariableDeclarator(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.id.type !== "Identifier" || !node.init) return;
      const init = node.init.type === "ChainExpression" ? node.init.expression : node.init;
      if (init.type !== "CallExpression" || !timerKind(init)) return;
      bindings.set(node.id.name, init);
    },
    AssignmentExpression(node) {
      if (!inScope(node) || node.left.type !== "Identifier") return;
      const right = node.right.type === "ChainExpression" ? node.right.expression : node.right;
      if (right.type !== "CallExpression" || !timerKind(right)) return;
      bindings.set(node.left.name, right);
    },
  }).visit(parsed.program);

  const seen = new Set<string>();
  const timers: OrphanedTimer[] = [];
  new Visitor({
    CallExpression(call) {
      if (!inScope(call)) return;
      const kind = timerKind(call);
      if (!kind) return;
      const key = `${call.start}:${call.end}`;
      if (seen.has(key)) return;
      seen.add(key);
      const storedAs = [...bindings.entries()].find(([, bound]) =>
        bound.start === call.start && bound.end === call.end
      )?.[0] ?? null;
      const clearEvidence = storedAs ? clearEvidenceFor(storedAs, source) : null;
      timers.push({
        source: nodeSource(call, source).slice(0, 300),
        kind,
        repeating: kind === "setInterval",
        storedAs,
        cleared: clearEvidence !== null,
        clearEvidence,
        line: lineAt(source, call.start),
      });
    },
  }).visit(parsed.program);
  if (timers.length === 0) return undefined;

  const teardownRanges: { name: string; start: number; end: number }[] = [];
  new Visitor({
    FunctionDeclaration(node) {
      if (!node.id || !TEARDOWN_NAME_PATTERN.test(node.id.name)) return;
      teardownRanges.push({ name: node.id.name, start: node.start, end: node.end });
    },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || !node.init) return;
      if (
        (node.init.type === "ArrowFunctionExpression" || node.init.type === "FunctionExpression")
        && TEARDOWN_NAME_PATTERN.test(node.id.name)
      ) teardownRanges.push({ name: node.id.name, start: node.start, end: node.end });
    },
  }).visit(parsed.program);

  const moduleReleases = [...source.matchAll(RELEASE_PATTERN)]
    .map((match) => match[0].slice(0, 40))
    .slice(0, 10);

  const name = functionName(parsed.program, fn);
  const parameters = fn.params.map((parameter) => source.slice(parameter.start, parameter.end));
  const callers = name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [];
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    timers,
    teardown: {
      present: teardownRanges.length > 0,
      names: [...new Set(teardownRanges.map(({ name: teardown }) => teardown))],
      clearsTimer: teardownRanges.some(({ start, end }) =>
        /clearInterval|clearTimeout|clearImmediate|\.unref\s*\(/.test(source.slice(start, end))
      ),
    },
    ownerLifetime: {
      handlerHints: [name ?? "", candidate.filePath].filter((text) => HANDLER_HINT_PATTERN.test(text)),
      hasRequestParameters: parameters.some((parameter) => REQUEST_PARAM_PATTERN.test(parameter)),
      repeatedCreation: callers.length > 1
        || parameters.some((parameter) => REQUEST_PARAM_PATTERN.test(parameter)),
    },
    moduleReleases,
    callers,
  };
}
