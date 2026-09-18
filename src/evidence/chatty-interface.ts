import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type {
  CallExpression,
  DoWhileStatement,
  ForInStatement,
  ForOfStatement,
  ForStatement,
  Node,
  Program,
  WhileStatement,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { moduleExportNames, parseProgram } from "./module.js";
import {
  calleeRootName,
  findDirectFunction,
  functionName,
  isFunctionExported,
  isInsideNestedFunction,
  moduleImports,
  nestedFunctionRanges,
  resolveModule,
} from "./repository.js";
import type { FunctionNode } from "./repository.js";

const MAX_LOOPS = 6;
const MAX_CALLS_PER_LOOP = 6;
const MAX_BATCH_NAMES = 5;
const MAX_ARG_NAMES = 8;
const MAX_CALL_CHARS = 240;

type LoopNode = ForStatement | ForOfStatement | ForInStatement | WhileStatement | DoWhileStatement;

export type ChattyCallEvidence = {
  call: string;
  callee: string;
  targetModule: string;
  awaited: boolean;
  invariantArgs: string[];
  variantArgs: string[];
};

export type ChattyLoopEvidence = {
  kind: string;
  source: string;
  calls: ChattyCallEvidence[];
  batchSiblings: { targetModule: string; names: string[] }[];
};

export type ChattyInterfaceEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  loops: ChattyLoopEvidence[];
};

function directRanges(fn: FunctionNode, candidate: Candidate) {
  return { start: Math.max(fn.start, candidate.start), end: Math.min(fn.end, candidate.end) };
}

function collectAwaited(program: Program, fn: FunctionNode, nested: { start: number; end: number }[]): Set<string> {
  const awaited = new Set<string>();
  new Visitor({
    AwaitExpression(node) {
      if (node.start < fn.start || node.end > fn.end) return;
      if (isInsideNestedFunction(node, nested)) return;
      const argument = node.argument;
      if (argument.type === "CallExpression") awaited.add(`${argument.start}:${argument.end}`);
    },
  }).visit(program);
  return awaited;
}

function identifiersIn(program: Program, node: Node, nested: { start: number; end: number }[]): Set<string> {
  const names = new Set<string>();
  new Visitor({
    Identifier(identifier) {
      if (identifier.start < node.start || identifier.end > node.end) return;
      if (isInsideNestedFunction(identifier, nested)) return;
      names.add(identifier.name);
    },
  }).visit(program);
  return names;
}

function assignedIn(
  program: Program,
  loop: LoopNode,
  nested: { start: number; end: number }[],
): Set<string> {
  const assigned = new Set<string>();
  const inLoop = (node: Node): boolean =>
    node.start >= loop.start && node.end <= loop.end && !isInsideNestedFunction(node, nested);
  new Visitor({
    AssignmentExpression(node) {
      if (!inLoop(node)) return;
      if (node.left.type === "Identifier") assigned.add(node.left.name);
    },
    UpdateExpression(node) {
      if (!inLoop(node)) return;
      if (node.argument.type === "Identifier") assigned.add(node.argument.name);
    },
    VariableDeclaration(node) {
      if (!inLoop(node)) return;
      for (const item of node.declarations) {
        if (item.id.type === "Identifier") assigned.add(item.id.name);
      }
    },
  }).visit(program);
  return assigned;
}

function singularStem(name: string): string {
  const bare = name.replace(/^(get|list|fetch|load|read|find)(?=[A-Z])/, "");
  return bare.charAt(0).toLowerCase() + bare.slice(1);
}

function batchSiblings(callee: string, targetPath: string, projectFiles: ProjectFile[]): string[] {
  const target = projectFiles.find((file) => file.filePath === targetPath);
  if (!target) return [];
  const program = parseProgram(targetPath, target.source);
  if (!program) return [];
  const stem = singularStem(callee);
  const calleeLower = callee.toLowerCase();
  const stemLower = stem.toLowerCase();
  const matches = moduleExportNames(program).filter((exportName) => {
    const lower = exportName.toLowerCase();
    if (lower === calleeLower) return false;
    if (/(batch|bulk|multi)/.test(lower)) return true;
    return lower === `${calleeLower}s`
      || lower === `${calleeLower}es`
      || lower === `all${stemLower}`
      || lower === `${stemLower}s`
      || lower === `${stemLower}es`;
  });
  return matches.slice(0, MAX_BATCH_NAMES);
}

export function buildChattyInterfaceEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ChattyInterfaceEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const imports = moduleImports(parsed.program);
  const byLocal = new Map(imports.map((item) => [item.local, item]));
  const nested = nestedFunctionRanges(parsed.program, candidate);
  const bounds = directRanges(fn, candidate);

  const loops: LoopNode[] = [];
  const collectLoop = (node: LoopNode): void => {
    if (node.start < bounds.start || node.end > bounds.end) return;
    if (isInsideNestedFunction(node, nested)) return;
    loops.push(node);
  };
  new Visitor({
    ForStatement: collectLoop,
    ForOfStatement: collectLoop,
    ForInStatement: collectLoop,
    WhileStatement: collectLoop,
    DoWhileStatement: collectLoop,
  }).visit(parsed.program);
  if (loops.length === 0) return undefined;

  const awaited = collectAwaited(parsed.program, fn, nested);
  const evidence: ChattyLoopEvidence[] = [];
  for (const loop of loops.slice(0, MAX_LOOPS)) {
    const loopCalls: CallExpression[] = [];
    const loopVisitor = {
      CallExpression(call: CallExpression) {
        if (call.start < loop.start || call.end > loop.end) return;
        if (isInsideNestedFunction(call, nested)) return;
        loopCalls.push(call);
      },
    };
    new Visitor(loopVisitor).visit(parsed.program);
    const variant = assignedIn(parsed.program, loop, nested);
    const calls: ChattyCallEvidence[] = [];
    const batchByTarget = new Map<string, string[]>();
    for (const call of loopCalls) {
      if (calls.length >= MAX_CALLS_PER_LOOP) break;
      const root = calleeRootName(call.callee);
      if (!root) continue;
      const imported = byLocal.get(root);
      if (!imported || !imported.source.startsWith(".")) continue;
      const target = resolveModule(owner.filePath, imported.source, projectFiles);
      if (!target || target.filePath === owner.filePath) continue;
      const referenced = [...identifiersIn(parsed.program, call, nested)]
        .filter((identifier) => identifier !== root);
      const invariantArgs = referenced.filter((identifier) => !variant.has(identifier)).slice(0, MAX_ARG_NAMES);
      const variantArgs = referenced.filter((identifier) => variant.has(identifier)).slice(0, MAX_ARG_NAMES);
      calls.push({
        call: owner.source.slice(call.start, call.end).slice(0, MAX_CALL_CHARS),
        callee: root,
        targetModule: target.filePath,
        awaited: awaited.has(`${call.start}:${call.end}`),
        invariantArgs,
        variantArgs,
      });
      if (!batchByTarget.has(target.filePath)) {
        batchByTarget.set(target.filePath, batchSiblings(root, target.filePath, projectFiles));
      }
    }
    if (calls.length === 0) continue;
    evidence.push({
      kind: loop.type,
      source: owner.source.slice(loop.start, loop.end).slice(0, 2_000),
      calls,
      batchSiblings: [...batchByTarget.entries()].map(([targetModule, names]) => ({ targetModule, names })),
    });
  }
  if (evidence.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    loops: evidence,
  };
}
