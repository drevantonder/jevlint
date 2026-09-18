import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  functionName,
  isFunctionExported,
  moduleImports,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionNode } from "./repository.js";

export type SyncCopy = {
  kind: "effect-sync" | "manual-sync" | "dual-write";
  target: string;
  source: string;
  line: number;
};

export type MirroredDerivedStateEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  sync: SyncCopy;
  sourceOrigin: "parameter" | "import" | "member" | "local" | "unknown";
  independentWrites: number;
  readsOfCopy: number;
  sourceAlsoInScope: boolean;
  otherReaders: {
    filePath: string;
    functionName: string;
  }[];
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function stateNameOfSetter(setter: string): string {
  const rest = setter.slice(3);
  return rest.charAt(0).toLowerCase() + rest.slice(1);
}

function paramNameSet(fn: FunctionNode, source: string): Set<string> {
  const names = new Set<string>();
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    const text = source.slice(value.start, value.end);
    for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return names;
}

function identifiersIn(source: string, start: number, end: number): string[] {
  const text = source.slice(start, end)
    .replace(/\.\s*[A-Za-z_$][\w$]*/g, "")
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "");
  const names: string[] = [];
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}

export function buildMirroredDerivedStateEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): MirroredDerivedStateEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const own = (start: number, end: number): boolean => {
    if (start < fn.start || end > fn.end) return false;
    return !nested.some((range) => range.start <= start && range.end >= end);
  };

  const syncs: SyncCopy[] = [];
  const writes = new Map<string, number>();
  const rhsHomes = new Map<string, Set<string>>();

  new Visitor({
    CallExpression(node) {
      if (!own(node.start, node.end)) return;
      const callee = node.callee;
      const isEffect = (callee.type === "Identifier" && callee.name === "useEffect")
        || (callee.type === "MemberExpression" && callee.property.type === "Identifier" && callee.property.name === "useEffect");
      if (!isEffect) return;
      const callback = node.arguments[0];
      const dependencies = node.arguments[1];
      if (!callback || !dependencies) return;
      if (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression") return;
      if (dependencies.type !== "ArrayExpression") return;
      const callbackSource = owner.source.slice(callback.start, callback.end);
      const depsSource = owner.source.slice(dependencies.start, dependencies.end);
      const setterMatch = /\b(set[A-Z][\w$]*)\s*\(/.exec(callbackSource);
      if (!setterMatch?.[1]) return;
      const setter = setterMatch[1];
      const target = stateNameOfSetter(setter);
      const referenced = identifiersIn(owner.source, callback.start, callback.end)
        .filter((identifier) => identifier !== setter && identifier !== target);
      const fromDeps = referenced.find((identifier) => depsSource.includes(identifier));
      if (!fromDeps) return;
      syncs.push({
        kind: "effect-sync",
        target,
        source: fromDeps,
        line: lineAt(owner.source, node.start),
      });
    },
    AssignmentExpression(node) {
      if (!own(node.start, node.end)) return;
      const left = node.left;
      const target = left.type === "MemberExpression"
        ? owner.source.slice(left.start, left.end)
        : left.type === "Identifier"
          ? left.name
          : null;
      if (!target) return;
      const rightNames = identifiersIn(owner.source, node.right.start, node.right.end)
        .filter((identifier) => identifier !== target);
      if (rightNames.length === 0) return;
      writes.set(target, (writes.get(target) ?? 0) + 1);
      const rhs = owner.source.slice(node.right.start, node.right.end);
      const homes = rhsHomes.get(rhs) ?? new Set<string>();
      homes.add(target);
      rhsHomes.set(rhs, homes);
      if (left.type !== "MemberExpression") return;
      syncs.push({
        kind: "manual-sync",
        target,
        source: rightNames[0] ?? "",
        line: lineAt(owner.source, node.start),
      });
    },
  }).visit(parsed.program);

  if (syncs.length === 0) {
    for (const homes of rhsHomes.values()) {
      if (homes.size < 2) continue;
      const targets = [...homes];
      const target = targets[0];
      const other = targets[1];
      if (!target || !other) continue;
      syncs.push({
        kind: "dual-write",
        target,
        source: other,
        line: lineAt(owner.source, fn.start),
      });
      break;
    }
  }

  if (syncs.length === 0) return undefined;
  const sync = syncs[0];
  if (!sync) return undefined;

  const targetWrites = writes.get(sync.target) ?? 0;
  const setterWrites = (owner.source.slice(fn.start, fn.end).match(new RegExp(`\\bset${sync.target.charAt(0).toUpperCase()}${sync.target.slice(1)}\\s*\\(`, "g")) ?? []).length;
  const independentWrites = Math.max(targetWrites + setterWrites - 1, 0);

  const fnSource = owner.source.slice(fn.start, fn.end);
  const escapedTarget = sync.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const readsOfCopy = (fnSource.match(new RegExp(`\\b${escapedTarget}\\b`, "g")) ?? []).length;
  const sourceAlsoInScope = new RegExp(`\\b${sync.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(fnSource);

  const params = paramNameSet(fn, owner.source);
  const imports = moduleImports(parsed.program);
  const sourceRoot = sync.source.split(".")[0] ?? sync.source;
  const sourceOrigin = params.has(sourceRoot)
    ? "parameter"
    : imports.some((item) => item.local === sourceRoot)
      ? "import"
      : /^(this|props|state|store)\b/.test(sync.source)
        ? "member"
        : "local";

  const otherReaders: MirroredDerivedStateEvidence["otherReaders"] = [];
  const functions: FunctionNode[] = [];
  new Visitor({
    ArrowFunctionExpression: (node) => {
      functions.push(node);
    },
    FunctionDeclaration: (node) => {
      functions.push(node);
    },
    FunctionExpression: (node) => {
      functions.push(node);
    },
  }).visit(parsed.program);
  for (const other of functions) {
    if (other.start === fn.start && other.end === fn.end) continue;
    const body = owner.source.slice(other.start, other.end);
    if (!new RegExp(`\\b${escapedTarget}\\b`).test(body)) continue;
    const otherName = functionName(parsed.program, other);
    if (!otherName) continue;
    otherReaders.push({ filePath: owner.filePath, functionName: otherName });
    if (otherReaders.length >= 12) break;
  }

  if (sync.kind === "manual-sync" && independentWrites === 0 && otherReaders.length === 0) {
    return undefined;
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    sync,
    sourceOrigin,
    independentWrites,
    readsOfCopy,
    sourceAlsoInScope,
    otherReaders,
  };
}
