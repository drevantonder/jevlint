import { parseSync, Visitor } from "oxc-parser";
import type { Class, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type { FunctionNode } from "./repository.js";

const MAX_SIBLINGS = 8;
const MAX_SNIPPET_CHARS = 1_200;
const SIMILARITY_FLOOR = 0.5;
const MIN_BASE_BODY_LINES = 4;

export type FragileOverrideEvidence = {
  override: {
    className: string;
    methodName: string;
    filePath: string;
    source: string;
    callsSuper: boolean;
  };
  base: {
    className: string;
    ownership: "same-module" | "project-module";
    filePath: string;
    methodName: string;
    source: string;
  };
  similarity: {
    sharedTokens: number;
    baseTokens: number;
    overrideTokens: number;
    ratio: number;
  };
  siblingOverrides: { filePath: string; className: string; callsSuper: boolean }[];
};

function memberName(member: Class["body"]["body"][number]): string | undefined {
  if (member.type !== "MethodDefinition") return undefined;
  const key = member.key;
  if (key.type === "Identifier") return key.name;
  return undefined;
}

function enclosingClass(
  program: Program,
  fn: FunctionNode,
): { node: Class; name: string } | undefined {
  let result: { node: Class; name: string } | undefined;
  new Visitor({
    ClassDeclaration(node) {
      if (node.start > fn.start || node.end < fn.end) return;
      const name = node.id?.name;
      if (!name) return;
      if (!result || (node.end - node.start) < (result.node.end - result.node.start)) {
        result = { node, name };
      }
    },
  }).visit(program);
  return result;
}

function overrideMethodName(
  cls: Class,
  fn: FunctionNode,
): string | undefined {
  for (const member of cls.body.body) {
    if (member.type !== "MethodDefinition") continue;
    if (member.kind === "constructor") continue;
    if (member.value !== fn) continue;
    return memberName(member);
  }
  return undefined;
}

function definedClass(file: ProjectFile, className: string): Class | undefined {
  const parsed = parseSync(file.filePath, file.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  let found: Class | undefined;
  new Visitor({
    ClassDeclaration(node) {
      if (node.id?.name === className) found = node;
    },
  }).visit(parsed.program);
  return found;
}

function defaultExportedClass(file: ProjectFile): Class | undefined {
  const parsed = parseSync(file.filePath, file.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  let found: Class | undefined;
  for (const statement of parsed.program.body) {
    if (statement.type !== "ExportDefaultDeclaration") continue;
    if (statement.declaration?.type === "ClassDeclaration") found = statement.declaration;
  }
  return found;
}

function findSuperclass(
  owner: ProjectFile,
  superName: string,
  projectFiles: ProjectFile[],
): { file: ProjectFile; node: Class } | undefined {
  const local = definedClass(owner, superName);
  if (local) return { file: owner, node: local };
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  for (const imported of moduleImports(parsed.program)) {
    if (imported.local !== superName) continue;
    const target = resolveModule(owner.filePath, imported.source, projectFiles);
    if (!target) continue;
    if (imported.imported === "default") {
      const byName = definedClass(target, superName);
      if (byName) return { file: target, node: byName };
      const defaulted = defaultExportedClass(target);
      if (defaulted) return { file: target, node: defaulted };
    } else if (imported.imported !== "*") {
      const remote = definedClass(target, imported.imported);
      if (remote) return { file: target, node: remote };
    }
  }
  return undefined;
}

function baseMethodSource(
  base: Class,
  methodName: string,
  source: string,
): string | undefined {
  for (const member of base.body.body) {
    if (member.type !== "MethodDefinition") continue;
    if (memberName(member) !== methodName) continue;
    return source.slice(member.start, member.end);
  }
  return undefined;
}

function callsSuperWithin(fn: FunctionNode, program: Program): boolean {
  let found = false;
  new Visitor({
    CallExpression(node) {
      if (found) return;
      if (node.start < fn.start || node.end > fn.end) return;
      const callee = node.callee;
      if (callee.type === "MemberExpression" && callee.object.type === "Super") found = true;
      if (callee.type === "Super") found = true;
    },
  }).visit(program);
  return found;
}

function tokensOf(source: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of source.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const token = match[0];
    if (token.length >= 3) tokens.add(token);
  }
  return tokens;
}

export function buildSubclassFragilityHookEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): FragileOverrideEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const enclosing = enclosingClass(parsed.program, fn);
  if (!enclosing) return undefined;
  const overrideName = overrideMethodName(enclosing.node, fn);
  if (!overrideName) return undefined;
  if (enclosing.node.superClass?.type !== "Identifier") return undefined;
  const superName = enclosing.node.superClass.name;

  const resolved = findSuperclass(owner, superName, projectFiles);
  if (!resolved) return undefined;
  const baseSource = baseMethodSource(resolved.node, overrideName, resolved.file.source);
  if (!baseSource) return undefined;

  const callsSuper = callsSuperWithin(fn, parsed.program);
  if (callsSuper) return undefined;

  const overrideBody = owner.source.slice(fn.start, fn.end);
  const baseBodyLines = baseSource.split("\n").length;
  if (baseBodyLines < MIN_BASE_BODY_LINES) return undefined;

  const baseTokens = tokensOf(baseSource);
  const overrideTokens = tokensOf(overrideBody);
  let shared = 0;
  for (const token of overrideTokens) {
    if (baseTokens.has(token)) shared += 1;
  }
  const ratio = shared / Math.max(1, Math.min(baseTokens.size, overrideTokens.size));
  if (ratio < SIMILARITY_FLOOR) return undefined;

  const siblingOverrides: { filePath: string; className: string; callsSuper: boolean }[] = [];
  for (const file of projectFiles) {
    if (siblingOverrides.length >= MAX_SIBLINGS) break;
    if (file.filePath === owner.filePath) continue;
    const fileParsed = parseSync(file.filePath, file.source, { range: true });
    if (fileParsed.errors.some((error) => error.severity === "Error")) continue;
    new Visitor({
      ClassDeclaration(node) {
        if (siblingOverrides.length >= MAX_SIBLINGS) return;
        if (node.superClass?.type !== "Identifier" || node.superClass.name !== superName) return;
        const className = node.id?.name;
        if (!className || className === enclosing.name) return;
        for (const member of node.body.body) {
          if (member.type !== "MethodDefinition" || memberName(member) !== overrideName) continue;
          if (member.value.type !== "FunctionExpression") continue;
          const memberFn: FunctionNode = member.value;
          siblingOverrides.push({
            filePath: file.filePath,
            className,
            callsSuper: callsSuperWithin(memberFn, fileParsed.program),
          });
        }
      },
    }).visit(fileParsed.program);
  }

  return {
    override: {
      className: enclosing.name,
      methodName: overrideName,
      filePath: owner.filePath,
      source: candidate.source.slice(0, MAX_SNIPPET_CHARS),
      callsSuper,
    },
    base: {
      className: superName,
      ownership: resolved.file.filePath === owner.filePath ? "same-module" : "project-module",
      filePath: resolved.file.filePath,
      methodName: overrideName,
      source: baseSource.slice(0, MAX_SNIPPET_CHARS),
    },
    similarity: {
      sharedTokens: shared,
      baseTokens: baseTokens.size,
      overrideTokens: overrideTokens.size,
      ratio: Math.round(ratio * 100) / 100,
    },
    siblingOverrides,
  };
}
