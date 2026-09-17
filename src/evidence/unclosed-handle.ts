import { parseSync, Visitor } from "oxc-parser";
import type { CallExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

const ACQUIRE_METHODS = new Set([
  "open",
  "openFile",
  "createReadStream",
  "createWriteStream",
  "connect",
  "createConnection",
  "getConnection",
  "acquire",
  "checkout",
  "lock",
  "acquireLock",
  "createClient",
  "createSession",
]);

const SUBSCRIPTION_METHODS = new Set([
  "addEventListener",
  "on",
  "subscribe",
  "listen",
  "setInterval",
  "setTimeout",
  "setImmediate",
]);

const RELEASE_PATTERN = /\bclose\s*\(|\brelease\s*\(|\bdispose\s*\(|\bdestroy\s*\(|\bdisconnect\s*\(|\bend\s*\(|\bunlock\s*\(|removeEventListener|\boff\s*\(|clearInterval|clearTimeout|\.abort\s*\(/g;
const RELEASE_TEST = /\bclose\s*\(|\brelease\s*\(|\bdispose\s*\(|\bdestroy\s*\(|\bdisconnect\s*\(|\bend\s*\(|\bunlock\s*\(|removeEventListener|\boff\s*\(|clearInterval|clearTimeout|\.abort\s*\(/;
const DISPOSER_PATTERN = /\busing\b|Disposable|Symbol\.asyncDispose|Symbol\.dispose|registerDisposable|onDispose/i;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

export type HandleAcquisition = {
  kind: string;
  call: string;
  boundAs: string | null;
  line: number;
};

export type UnclosedHandleEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  acquisitions: HandleAcquisition[];
  releasesInFunction: string[];
  earlyReturnWithoutRelease: boolean;
  ownershipTransfer: {
    returned: boolean;
    registeredWithDisposer: boolean;
  };
  moduleReleases: string[];
  callers: FunctionCaller[];
};

function acquireKind(call: CallExpression): string | undefined {
  const callee = call.callee.type === "ChainExpression" ? call.callee.expression : call.callee;
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
    const method = callee.property.name;
    if (SUBSCRIPTION_METHODS.has(method)) return undefined;
    return ACQUIRE_METHODS.has(method) ? method : undefined;
  }
  if (callee.type === "Identifier") {
    if (SUBSCRIPTION_METHODS.has(callee.name)) return undefined;
    return ACQUIRE_METHODS.has(callee.name) ? callee.name : undefined;
  }
  return undefined;
}

export function buildUnclosedHandleEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnclosedHandleEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const nested = nestedFunctionRanges(parsed.program, fn);
  const source = owner.source;

  const boundHandles = new Map<string, CallExpression>();
  new Visitor({
    VariableDeclarator(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.id.type !== "Identifier" || !node.init) return;
      const init = node.init.type === "ChainExpression" ? node.init.expression : node.init;
      if (init.type !== "CallExpression" && init.type !== "AwaitExpression") return;
      const call = init.type === "AwaitExpression" && init.argument.type === "CallExpression"
        ? init.argument
        : init.type === "CallExpression"
          ? init
          : undefined;
      if (!call || !acquireKind(call)) return;
      boundHandles.set(node.id.name, call);
    },
  }).visit(parsed.program);

  const acquisitions: HandleAcquisition[] = [];
  const seen = new Set<string>();
  new Visitor({
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      const kind = acquireKind(call);
      if (!kind) return;
      const key = `${call.start}:${call.end}`;
      if (seen.has(key)) return;
      seen.add(key);
      const boundAs = [...boundHandles.entries()].find(([, bound]) =>
        bound.start === call.start && bound.end === call.end
      )?.[0] ?? null;
      acquisitions.push({
        kind,
        call: source.slice(call.start, call.end).slice(0, 300),
        boundAs,
        line: lineAt(source, call.start),
      });
    },
  }).visit(parsed.program);
  if (acquisitions.length === 0) return undefined;

  const functionText = source.slice(candidate.start, candidate.end);
  const releasesInFunction = [...functionText.matchAll(RELEASE_PATTERN)]
    .map((match) => match[0].slice(0, 60))
    .slice(0, 10);
  const finallyReleases = /finally\s*\{[\s\S]*?(?:close|release|dispose|destroy|disconnect|end|unlock)\s*\(/.test(functionText);

  let earlyReturnWithoutRelease = false;
  new Visitor({
    ReturnStatement(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (finallyReleases) return;
      const before = source.slice(candidate.start, node.start);
      if (!RELEASE_TEST.test(before)) earlyReturnWithoutRelease = true;
    },
  }).visit(parsed.program);

  let returned = false;
  new Visitor({
    ReturnStatement(node) {
      if (!containsNode(fn, node)) return;
      const text = source.slice(node.start, node.end);
      if ([...boundHandles.keys()].some((handle) => new RegExp(`\\b${handle}\\b`).test(text))) {
        returned = true;
      }
    },
  }).visit(parsed.program);

  const moduleReleases = [...source.matchAll(RELEASE_PATTERN)]
    .map((match) => match[0].slice(0, 40))
    .slice(0, 10);

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    acquisitions,
    releasesInFunction,
    earlyReturnWithoutRelease,
    ownershipTransfer: {
      returned,
      registeredWithDisposer: DISPOSER_PATTERN.test(functionText),
    },
    moduleReleases,
    callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
  };
}
