import { Visitor } from "oxc-parser";
import type { MethodDefinition, Program, PropertyDefinition } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type StutteringScope = {
  className: string | null;
  fileStem: string;
  qualifier: string | null;
  scopeTokens: string[];
};

export type StutteringSibling = {
  name: string;
  where: string;
  sharedTokens: string[];
};

export type StutteringQualifiedUse = {
  object: string;
  member: string;
  filePath: string;
  line: number;
};

export type StutteringScopeNameEvidence = {
  function: {
    name: string;
    nameTokens: string[];
    exported: boolean;
    filePath: string;
    source: string;
  };
  scope: StutteringScope;
  sharedTokens: string[];
  siblings: StutteringSibling[];
  qualifiedUses: StutteringQualifiedUse[];
  callers: FunctionCaller[];
};

/** File stems that carry no scope vocabulary, so overlap with them is coincidence. */
const GENERIC_STEMS = new Set(["index", "main", "mod", "lib", "src"]);

/** Directory names that carry no package vocabulary. */
const GENERIC_DIRECTORIES = new Set([
  "src",
  "lib",
  "test",
  "tests",
  "__tests__",
  "dist",
  "build",
  "node_modules",
]);

export function tokenizeName(value: string): string[] {
  const tokens = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2);
  return [...new Set(tokens)];
}

function fileStemOf(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function qualifierOf(filePath: string): string | null {
  const parts = filePath.split("/");
  if (parts.length < 2) return null;
  const parent = parts[parts.length - 2] ?? "";
  if (parent === "" || GENERIC_DIRECTORIES.has(parent)) return null;
  return parent;
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function enclosingClassRange(
  source: string,
  filePath: string,
  candidate: Candidate,
): { name: string; start: number; end: number } | null {
  const parsed = parseCached(filePath, source);
  let best: { name: string; start: number; end: number } | null = null;
  new Visitor({
    ClassDeclaration(node) {
      if (!node.id || node.start > candidate.start || node.end < candidate.end) return;
      const size = node.end - node.start;
      if (best && best.end - best.start <= size) return;
      best = { name: node.id.name, start: node.start, end: node.end };
    },
  }).visit(parsed.program);
  return best;
}

function siblingNames(
  source: string,
  filePath: string,
  candidate: Candidate,
  enclosing: { name: string; start: number; end: number } | null,
  ownName: string,
): Array<{ name: string; where: string }> {
  const parsed = parseCached(filePath, source);
  const siblings: Array<{ name: string; where: string }> = [];
  const seen = new Set([ownName]);
  const push = (name: string, where: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    siblings.push({ name, where });
  };
  if (enclosing !== null) {
    const nested: Array<{ start: number; end: number }> = [];
    new Visitor({
      ClassDeclaration(node) {
        if (node.start >= enclosing.start && node.end <= enclosing.end
          && (node.start !== enclosing.start || node.end !== enclosing.end)) {
          nested.push({ start: node.start, end: node.end });
        }
      },
    }).visit(parsed.program);
    const direct = (start: number, end: number): boolean =>
      start >= enclosing.start && end <= enclosing.end
      && !nested.some((range) => range.start <= start && range.end >= end);
    new Visitor({
      MethodDefinition(node) {
        if (!direct(node.start, node.end)) return;
        const name = memberKeyName(node.key);
        if (name === null) return;
        push(name, `class:${enclosing.name}`);
      },
      PropertyDefinition(node) {
        if (!direct(node.start, node.end)) return;
        const name = memberKeyName(node.key);
        if (name === null) return;
        push(name, `class:${enclosing.name}`);
      },
    }).visit(parsed.program);
    return siblings.slice(0, 12);
  }
  for (const name of topLevelFunctionNames(source, filePath, candidate, ownName)) {
    push(name, `module:${filePath}`);
  }
  return siblings.slice(0, 12);
}

function topLevelFunctionNames(
  source: string,
  filePath: string,
  candidate: Candidate,
  ownName: string,
): string[] {
  const parsed = parseCached(filePath, source);
  const names: string[] = [];
  const seen = new Set([ownName]);
  new Visitor({
    FunctionDeclaration(node) {
      if (!node.id || seen.has(node.id.name)) return;
      if (node.start > candidate.start && node.end <= candidate.end) return;
      seen.add(node.id.name);
      names.push(node.id.name);
    },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || seen.has(node.id.name)) return;
      if (node.start > candidate.start && node.end <= candidate.end) return;
      if (node.init?.type !== "ArrowFunctionExpression" && node.init?.type !== "FunctionExpression") {
        return;
      }
      seen.add(node.id.name);
      names.push(node.id.name);
    },
  }).visit(parsed.program);
  return names.slice(0, 12);
}

function qualifiedUsesOf(
  member: string,
  projectFiles: ProjectFile[],
): StutteringQualifiedUse[] {
  const uses: StutteringQualifiedUse[] = [];
  const pattern = new RegExp(`([A-Za-z_$][\\w$]*)\\.${member.replace(/[$]/g, "\\$")}(?![\\w$])`, "g");
  for (const file of projectFiles) {
    if (uses.length >= 10) break;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(file.source)) !== null && uses.length < 10) {
      uses.push({
        object: match[1] ?? "",
        member,
        filePath: file.filePath,
        line: lineAt(file.source, match.index),
      });
    }
  }
  return uses;
}

/** Member keys we can judge: plain identifiers. String-literal or computed
 * keys carry no stable name token stream, so deterministic analysis leaves
 * them out and the builder abstains where they are the only signal. */
function memberKeyName(key: MethodDefinition["key"] | PropertyDefinition["key"]): string | null {
  if (key.type === "Identifier") return key.name;
  return null;
}

/** Name a function expression from its declaration site, including class members. */
function resolveFunctionName(
  program: Program,
  fn: FunctionNode,
): { name: string; exported: boolean } | undefined {
  const direct = functionName(program, fn);
  if (direct) return { name: direct, exported: isFunctionExported(program, fn, direct) };
  let member: { name: string; exported: boolean } | undefined;
  new Visitor({
    MethodDefinition(node) {
      if (node.value !== fn || member) return;
      const name = memberKeyName(node.key);
      if (name === null || name === "constructor") return;
      member = { name, exported: true };
    },
    PropertyDefinition(node) {
      if (node.value !== fn || member) return;
      const name = memberKeyName(node.key);
      if (name === null) return;
      member = { name, exported: true };
    },
  }).visit(program);
  if (member) {
    // A member is reachable wherever its class is; mirror the class export signal.
    let classExported = false;
    new Visitor({
      ClassDeclaration(node) {
        if (node.start > fn.start || node.end < fn.end) return;
        for (const statement of program.body) {
          if (statement.type === "ExportDefaultDeclaration" && statement.declaration === node) {
            classExported = true;
          }
          if (statement.type === "ExportNamedDeclaration" && statement.declaration === node) {
            classExported = true;
          }
        }
      },
    }).visit(program);
    return { name: member.name, exported: classExported };
  }
  return undefined;
}

export function buildStutteringScopeNameEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): StutteringScopeNameEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const resolved = resolveFunctionName(parsed.program, fn);
  if (!resolved) return undefined;
  const { name } = resolved;

  const nameTokens = tokenizeName(name);
  if (nameTokens.length === 0) return undefined;

  const enclosing = enclosingClassRange(owner.source, owner.filePath, candidate);
  const className = enclosing?.name ?? null;
  const stem = fileStemOf(owner.filePath);
  const qualifier = qualifierOf(owner.filePath);

  const scopeTokenSet = new Set<string>();
  if (className !== null) {
    for (const token of tokenizeName(className)) scopeTokenSet.add(token);
  }
  if (!GENERIC_STEMS.has(stem.toLowerCase())) {
    for (const token of tokenizeName(stem)) scopeTokenSet.add(token);
  }
  if (qualifier !== null) {
    for (const token of tokenizeName(qualifier)) scopeTokenSet.add(token);
  }
  if (scopeTokenSet.size === 0) return undefined;

  const nameTokenSet = new Set(nameTokens);
  const sharedTokens = [...scopeTokenSet].filter((token) => nameTokenSet.has(token));
  if (sharedTokens.length === 0) return undefined;

  const shared = new Set(sharedTokens);
  const siblings: StutteringSibling[] = [];
  for (const sibling of siblingNames(owner.source, owner.filePath, candidate, enclosing, name)) {
    const overlap = tokenizeName(sibling.name).filter((token) => shared.has(token));
    if (overlap.length === 0) continue;
    siblings.push({ name: sibling.name, where: sibling.where, sharedTokens: overlap });
    if (siblings.length >= 8) break;
  }

  return {
    function: {
      name,
      nameTokens,
      exported: resolved.exported,
      filePath: owner.filePath,
      source: candidate.source,
    },
    scope: {
      className,
      fileStem: stem,
      qualifier,
      scopeTokens: [...scopeTokenSet],
    },
    sharedTokens,
    siblings,
    qualifiedUses: qualifiedUsesOf(name, projectFiles),
    callers: findFunctionCallers(owner.filePath, name, projectFiles),
  };
}
