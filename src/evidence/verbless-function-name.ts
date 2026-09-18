import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type VerblessFunctionEvidence = {
  function: {
    name: string;
    firstWord: string;
    exported: boolean;
    frameworkConventional: boolean;
    filePath: string;
    source: string;
  };
  body: {
    calls: number;
    mutations: number;
    throws: number;
    awaits: number;
    branches: number;
    returnsValue: boolean;
    excerpts: string[];
  };
  callers: FunctionCaller[];
  verbAliasedCallers: { filePath: string; line: number; call: string }[];
};

const MAX_EXCERPT_CHARS = 240;

// Verb heads that state an action, including boolean-predicate prefixes.
const VERBS = new Set([
  "is", "has", "can", "should", "will", "did", "was", "needs", "must",
  "get", "set", "fetch", "load", "save", "store", "create", "make", "build",
  "update", "delete", "remove", "add", "insert", "append", "push", "pop",
  "compute", "calculate", "derive", "render", "draw", "paint", "parse", "format",
  "stringify", "validate", "verify", "check", "ensure", "assert", "find", "search",
  "lookup", "query", "filter", "map", "reduce", "select", "pick", "omit", "merge",
  "combine", "join", "split", "sort", "order", "group", "send", "receive", "emit",
  "publish", "subscribe", "handle", "process", "run", "execute", "perform", "apply",
  "invoke", "call", "trigger", "start", "stop", "open", "close", "connect",
  "disconnect", "subscribe", "register", "unregister", "subscribe", "enable",
  "disable", "show", "hide", "toggle", "reset", "clear", "refresh", "reload",
  "retry", "cancel", "abort", "pause", "resume", "normalize", "transform",
  "convert", "serialize", "deserialize", "encode", "decode", "compress", "hash",
  "encrypt", "decrypt", "sign", "authenticate", "authorize", "grant", "revoke",
  "notify", "log", "warn", "report", "track", "measure", "count", "sum",
  "compare", "match", "test", "try", "do", "await", "resolve", "reject",
  "clone", "copy", "move", "rename", "write", "read", "print", "display",
  "produce", "generate", "collect", "gather", "aggregate", "deduplicate",
]);

function firstWord(name: string): string {
  const stripped = name.replace(/^_+/, "");
  const parts = stripped.split(/(?=[A-Z])/);
  const head = (parts[0] ?? stripped).split(/[^A-Za-z]/)[0] ?? stripped;
  return head.toLowerCase();
}

function leadingIdentifier(call: string): string | undefined {
  const match = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(call);
  return match?.[1];
}

export function buildVerblessFunctionNameEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): VerblessFunctionEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name || name === "constructor") return undefined;

  const head = firstWord(name);
  if (VERBS.has(head)) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const direct = (node: { start: number; end: number }): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !nested.some((range) => range.start <= node.start && range.end >= node.end);

  let calls = 0;
  let mutations = 0;
  let throws = 0;
  let awaits = 0;
  let branches = 0;
  let returnsValue = false;
  const excerpts: string[] = [];
  const pushExcerpt = (start: number, end: number): void => {
    if (excerpts.length >= 5) return;
    excerpts.push(owner.source.slice(start, end).slice(0, MAX_EXCERPT_CHARS));
  };

  new Visitor({
    CallExpression(node) {
      if (!direct(node)) return;
      calls += 1;
      if (calls === 1) pushExcerpt(node.start, node.end);
    },
    AssignmentExpression(node) {
      if (!direct(node)) return;
      mutations += 1;
      if (mutations === 1) pushExcerpt(node.start, node.end);
    },
    UpdateExpression(node) {
      if (!direct(node)) return;
      mutations += 1;
    },
    ThrowStatement(node) {
      if (!direct(node)) return;
      throws += 1;
      pushExcerpt(node.start, node.end);
    },
    AwaitExpression(node) {
      if (!direct(node)) return;
      awaits += 1;
    },
    IfStatement(node) {
      if (!direct(node)) return;
      branches += 1;
      if (branches === 1) pushExcerpt(node.start, node.end);
    },
    SwitchStatement(node) {
      if (!direct(node)) return;
      branches += 1;
    },
    ConditionalExpression(node) {
      if (!direct(node)) return;
      branches += 1;
    },
    ReturnStatement(node) {
      if (!direct(node) || !node.argument) return;
      if (node.argument.type !== "Identifier") returnsValue = true;
    },
  }).visit(parsed.program);

  if (calls + mutations + throws + awaits + branches === 0 && !returnsValue) return undefined;

  const callers = findFunctionCallers(owner.filePath, name, projectFiles);
  const verbAliasedCallers = callers
    .flatMap((caller) => {
      const alias = leadingIdentifier(caller.call);
      if (!alias || alias === name || !VERBS.has(firstWord(alias))) return [];
      return [{ filePath: caller.filePath, line: caller.line, call: caller.call }];
    })
    .slice(0, 5);

  return {
    function: {
      name,
      firstWord: head,
      exported: isFunctionExported(parsed.program, fn, name),
      frameworkConventional: /^[A-Z]/.test(name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    body: { calls, mutations, throws, awaits, branches, returnsValue, excerpts },
    callers,
    verbAliasedCallers,
  };
}
