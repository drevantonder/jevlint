import { parseSync } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

const MAX_SIBLINGS = 6;
const MAX_CALLERS_PER_SIBLING = 4;
const MAX_EXCERPT_CHARS = 800;

const SYNC_IO_PATTERN = /[A-Za-z_$][\w$]*Sync\s*\(/;
const PROMISE_ANNOTATION_PATTERN = /\bPromise\b/;

export type SyncAsyncSuffix = "Sync" | "Async" | null;

export type SyncAsyncSibling = {
  name: string;
  exported: boolean;
  isAsync: boolean;
  suffix: SyncAsyncSuffix;
  performsSyncIo: boolean;
  awaitedUses: number;
  bareUses: number;
  excerpt: string;
  callers: FunctionCaller[];
};

export type SyncAsyncSiblingAmbiguityEvidence = {
  function: {
    name: string;
    exported: boolean;
    isAsync: boolean;
    suffix: SyncAsyncSuffix;
    performsSyncIo: boolean;
    filePath: string;
    source: string;
  };
  stem: string;
  siblings: SyncAsyncSibling[];
  suffixConvention: "consistent" | "asymmetric" | "unsuffixed";
  callers: FunctionCaller[];
};

function suffixOf(name: string): SyncAsyncSuffix {
  if (name.endsWith("Sync") && name.length > 4) return "Sync";
  if (name.endsWith("Async") && name.length > 5) return "Async";
  return null;
}

function stemOf(name: string): string {
  const suffix = suffixOf(name);
  return suffix ? name.slice(0, -suffix.length) : name;
}

function sameStem(first: string, second: string): boolean {
  if (first === second) return true;
  const firstStem = stemOf(first);
  const secondStem = stemOf(second);
  if (firstStem === secondStem) return true;
  if (firstStem.length >= 3 && second.startsWith(firstStem)) return true;
  return secondStem.length >= 3 && first.startsWith(secondStem);
}

function returnAnnotation(fn: FunctionNode, source: string): string | null {
  const paramsEnd = fn.params.length > 0 ? fn.params[fn.params.length - 1]?.end : undefined;
  const bodyStart = fn.body?.start;
  if (paramsEnd === undefined || bodyStart === undefined) return null;
  const between = source.slice(paramsEnd, bodyStart);
  const match = /\)\s*:\s*(.+?)\s*(?:=>)?$/.exec(between.trim());
  return match?.[1]?.trim() ?? null;
}

function isAsyncFunction(fn: FunctionNode, source: string): boolean {
  if (fn.async) return true;
  const annotation = returnAnnotation(fn, source);
  return annotation !== null && PROMISE_ANNOTATION_PATTERN.test(annotation);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countUses(projectFiles: ProjectFile[], name: string) {
  const barePattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "g");
  const awaitedPattern = new RegExp(`await\\s+${escapeRegExp(name)}\\s*\\(`, "g");
  let awaited = 0;
  let bare = 0;
  for (const file of projectFiles) {
    awaited += file.source.match(awaitedPattern)?.length ?? 0;
    const total = file.source.match(barePattern)?.length ?? 0;
    bare += Math.max(0, total - (file.source.match(awaitedPattern)?.length ?? 0));
  }
  return { awaited, bare };
}

type ModuleFunction = {
  name: string;
  node: FunctionNode;
  exported: boolean;
};

function moduleFunctions(program: ReturnType<typeof parseSync>["program"]): ModuleFunction[] {
  const functions: ModuleFunction[] = [];
  for (const statement of program.body) {
    const exported = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration";
    const declaration = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
      ? statement.declaration
      : statement;
    if (declaration?.type === "FunctionDeclaration") {
      const name = declaration.id?.name ?? (statement.type === "ExportDefaultDeclaration" ? "default" : undefined);
      if (name) functions.push({ name, node: declaration, exported });
      continue;
    }
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const item of declaration.declarations) {
      if (item.id.type !== "Identifier" || !item.init) continue;
      if (item.init.type === "ArrowFunctionExpression" || item.init.type === "FunctionExpression") {
        functions.push({ name: item.id.name, node: item.init, exported });
      }
    }
  }
  return functions;
}

function suffixConvention(
  candidateName: string,
  candidateAsync: boolean,
  siblings: { name: string; isAsync: boolean; suffix: SyncAsyncSuffix }[],
): "consistent" | "asymmetric" | "unsuffixed" {
  const members = [
    { name: candidateName, isAsync: candidateAsync, suffix: suffixOf(candidateName) },
    ...siblings,
  ];
  if (members.every(({ suffix }) => suffix === null)) return "unsuffixed";
  for (const member of members) {
    if (member.suffix === "Sync" && member.isAsync) return "asymmetric";
    if (member.suffix === "Async" && !member.isAsync) return "asymmetric";
  }
  const asyncValues = new Set(members.map(({ isAsync }) => isAsync));
  if (asyncValues.size < 2) return "asymmetric";
  return "consistent";
}

export function buildSyncAsyncSiblingAmbiguityEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): SyncAsyncSiblingAmbiguityEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const stem = stemOf(name);
  if (!stem) return undefined;
  const candidateAsync = isAsyncFunction(fn, owner.source);

  const siblings: SyncAsyncSibling[] = [];
  for (const other of moduleFunctions(parsed.program)) {
    if (other.name === name || siblings.length >= MAX_SIBLINGS) continue;
    if (!sameStem(name, other.name)) continue;
    const siblingSource = owner.source.slice(other.node.start, other.node.end);
    const uses = countUses(projectFiles, other.name);
    siblings.push({
      name: other.name,
      exported: other.exported,
      isAsync: isAsyncFunction(other.node, owner.source),
      suffix: suffixOf(other.name),
      performsSyncIo: SYNC_IO_PATTERN.test(siblingSource),
      awaitedUses: uses.awaited,
      bareUses: uses.bare,
      excerpt: siblingSource.slice(0, MAX_EXCERPT_CHARS),
      callers: findFunctionCallers(candidate.filePath, other.name, projectFiles)
        .slice(0, MAX_CALLERS_PER_SIBLING),
    });
  }
  if (siblings.length === 0) return undefined;

  let sharedStem = stem;
  for (const sibling of siblings) {
    const siblingStem = stemOf(sibling.name);
    if (sharedStem.startsWith(siblingStem) && siblingStem.length < sharedStem.length) {
      sharedStem = siblingStem;
    }
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      isAsync: candidateAsync,
      suffix: suffixOf(name),
      performsSyncIo: SYNC_IO_PATTERN.test(candidate.source),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    stem: sharedStem,
    siblings,
    suffixConvention: suffixConvention(name, candidateAsync, siblings),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
