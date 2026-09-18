import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Expression, Node } from "oxc-parser";
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

export type CheckActSequence = {
  check: string;
  checkLine: number;
  interveningAwaits: string[];
  mutation: string;
  mutationLine: number;
  sameResource: boolean;
};

export type CheckThenActRaceEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  sequences: CheckActSequence[];
  atomicSignals: string[];
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

const MUTATION_METHOD = /^(set|delete|remove|save|update|create|insert|upsert|push|publish|send|write|destroy|increment|decrement)$/;
const MUTATION_CALL = /save|update|delete|create|publish|send|write|insert|charge|mutat|persist|store|commit/i;
const CHECK_CALL = /^(has|get|exists|find|load|read|check|verify|peek|contains|includes)$/;
const ATOMIC_SIGNAL = /transaction|mutex|lock|compareAndSet|compareAndSwap|singleflight|singleFlight|dedupe|idempoten|acquire|semaphore/i;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function finalName(callee: CallExpression["callee"]): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression") {
    if (callee.property.type === "Identifier") return callee.property.name;
    if (callee.property.type === "Literal") return String(callee.property.value);
  }
  return null;
}

function rootName(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    if (expression.object.type === "Super") return undefined;
    return rootName(expression.object);
  }
  if (expression.type === "ChainExpression") return rootName(expression.expression);
  if (expression.type === "CallExpression") {
    if (expression.callee.type === "MemberExpression") return rootName(expression.callee.object);
    if (expression.callee.type === "Identifier") return expression.callee.name;
  }
  return undefined;
}

function callRoot(call: CallExpression): string | undefined {
  if (call.callee.type === "MemberExpression") return rootName(call.callee.object);
  if (call.callee.type === "Identifier") {
    const name = call.callee.name;
    return name === "await" ? undefined : name;
  }
  return undefined;
}

function resourceTokens(node: Node, source: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of nodeSource(node, source).matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (match[0].length > 1) tokens.add(match[0]);
  }
  return tokens;
}

export function buildCheckThenActRaceEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): CheckThenActRaceEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const inScope = (node: Node): boolean =>
    containsNode(fn, node) && belongsDirectlyToFunction(node, nested);

  const checks: { node: Node; root: string | undefined }[] = [];
  new Visitor({
    IfStatement(node) {
      if (!inScope(node)) return;
      const text = nodeSource(node.test, ownerFile.source);
      let root: string | undefined;
      new Visitor({
        CallExpression(call) {
          if (!containsNode(node.test, call)) return;
          const name = finalName(call.callee);
          if (name && CHECK_CALL.test(name)) root ??= callRoot(call);
        },
      }).visit(parsed.program);
      if (root === undefined && /=|===|!==|>|<|has|exists|owner/i.test(text)) {
        const first = /[A-Za-z_$][\w$]*/.exec(text);
        root = first?.[0];
      }
      if (root !== undefined) checks.push({ node, root });
    },
  }).visit(parsed.program);

  const awaits: Node[] = [];
  new Visitor({
    AwaitExpression(node) {
      if (inScope(node)) awaits.push(node);
    },
  }).visit(parsed.program);

  const mutations: { node: CallExpression; root: string | undefined }[] = [];
  new Visitor({
    CallExpression(node) {
      if (!inScope(node)) return;
      const name = finalName(node.callee);
      if (!name) return;
      if (MUTATION_METHOD.test(name) || MUTATION_CALL.test(name)) {
        mutations.push({ node, root: callRoot(node) });
      }
    },
  }).visit(parsed.program);

  const sequences: CheckActSequence[] = [];
  for (const check of checks) {
    const gap = awaits.filter((awaited) => awaited.start > check.node.start);
    if (gap.length === 0) continue;
    const firstAwait = gap[0];
    if (!firstAwait) continue;
    for (const mutation of mutations) {
      if (mutation.node.start < firstAwait.start) continue;
      const checkTokens = resourceTokens(check.node, ownerFile.source);
      const mutationTokens = resourceTokens(mutation.node, ownerFile.source);
      const shared = [...checkTokens].some((token) => mutationTokens.has(token));
      sequences.push({
        check: nodeSource(check.node, ownerFile.source).slice(0, 300),
        checkLine: lineAt(ownerFile.source, check.node.start),
        interveningAwaits: gap
          .filter((awaited) => awaited.start < mutation.node.start)
          .map((awaited) => nodeSource(awaited, ownerFile.source).slice(0, 160)),
        mutation: nodeSource(mutation.node, ownerFile.source).slice(0, 300),
        mutationLine: lineAt(ownerFile.source, mutation.node.start),
        sameResource: shared || check.root === mutation.root,
      });
    }
  }
  if (sequences.length === 0) return undefined;

  const atomic = new Set<string>();
  new Visitor({
    Identifier(node) {
      if (!inScope(node)) return;
      if (ATOMIC_SIGNAL.test(node.name)) atomic.add(node.name);
    },
  }).visit(parsed.program);

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    sequences: sequences.slice(0, 10),
    atomicSignals: [...atomic],
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(
        candidate.filePath,
        parsed.program,
        projectFiles,
      ),
    },
  };
}
