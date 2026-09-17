import { parseSync, Visitor } from "oxc-parser";
import type { CallExpression, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  functionName,
  isFunctionExported,
  isInsideNestedFunction,
  moduleImports,
  nestedFunctionRanges,
  resolveModule,
} from "./repository.js";
import type { FunctionNode } from "./repository.js";

const FIRST_HOP_CAP = 8;
const SECOND_HOP_CAP = 6;

export type DelegationNext = {
  callee: string;
  targetModule: string | null;
  importedFrom: string | null;
};

export type DelegationHop = {
  callee: string;
  targetModule: string;
  importedFrom: string;
  passThrough: boolean;
  addsGuard: boolean;
  next: DelegationNext[];
};

export type DeepDelegationChainEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  chain: {
    hops: DelegationHop[];
    depth: number;
    moduleCrossings: number;
    passThroughHops: number;
  };
};

function programOf(filePath: string, source: string): Program | undefined {
  const parsed = parseSync(filePath, source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  return parsed.program;
}

function calleeRootName(callee: CallExpression["callee"]): string | undefined {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression") {
    let object = callee.object;
    while (object.type === "MemberExpression") object = object.object;
    if (object.type === "CallExpression") return calleeRootName(object.callee);
    return object.type === "Identifier" ? object.name : undefined;
  }
  if (callee.type === "ChainExpression") {
    const chained = callee.expression;
    if (chained.type === "CallExpression") return calleeRootName(chained.callee);
  }
  return undefined;
}

function collectCallees(program: Program, node: FunctionNode): string[] {
  // SAFETY: nestedFunctionRanges reads only the start/end offsets, both taken
  // from a parsed function node, so the remaining candidate fields are unused.
  const ranges = nestedFunctionRanges(program, {
    start: node.start,
    end: node.end,
  } as Candidate);
  const names: string[] = [];
  new Visitor({
    CallExpression(call) {
      if (call.start < node.start || call.end > node.end) return;
      if (isInsideNestedFunction(call, ranges)) return;
      const root = calleeRootName(call.callee);
      if (root && !names.includes(root)) names.push(root);
    },
  }).visit(program);
  return names;
}

function containsGuardStatement(program: Program, node: FunctionNode): boolean {
  let guarded = false;
  new Visitor({
    IfStatement(ifNode) {
      if (ifNode.start >= node.start && ifNode.end <= node.end) guarded = true;
    },
    ThrowStatement(throwNode) {
      if (throwNode.start >= node.start && throwNode.end <= node.end) guarded = true;
    },
    TryStatement(tryNode) {
      if (tryNode.start >= node.start && tryNode.end <= node.end) guarded = true;
    },
    SwitchStatement(switchNode) {
      if (switchNode.start >= node.start && switchNode.end <= node.end) guarded = true;
    },
  }).visit(program);
  return guarded;
}

function forwardsDirectly(node: FunctionNode): boolean {
  if (!node.body) return false;
  if (node.body.type !== "BlockStatement") {
    return node.body.type === "CallExpression" || (node.body.type === "ChainExpression"
      && node.body.expression.type === "CallExpression");
  }
  if (node.body.body.length !== 1) return false;
  const statement = node.body.body[0];
  if (!statement || statement.type !== "ReturnStatement" || !statement.argument) return false;
  const argument = statement.argument;
  return argument.type === "CallExpression"
    || (argument.type === "AwaitExpression" && argument.argument.type === "CallExpression");
}

function findNamedFunction(program: Program, name: string): FunctionNode | undefined {
  let result: FunctionNode | undefined;
  new Visitor({
    FunctionDeclaration(node) {
      if (node.id?.name === name && !result) result = node;
    },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || node.id.name !== name) return;
      if (
        node.init?.type === "ArrowFunctionExpression"
        || node.init?.type === "FunctionExpression"
      ) {
        if (!result) result = node.init;
      }
    },
  }).visit(program);
  return result;
}

export function buildDeepDelegationChainEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DeepDelegationChainEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const program = programOf(owner.filePath, owner.source);
  if (!program) return undefined;
  const fn = findDirectFunction(program, candidate);
  if (!fn) return undefined;
  const name = functionName(program, fn);
  if (!name) return undefined;

  const imports = moduleImports(program);
  const firstHops = collectCallees(program, fn).slice(0, FIRST_HOP_CAP);
  const hops: DelegationHop[] = [];

  for (const callee of firstHops) {
    const imported = imports.find(({ local }) => local === callee);
    if (!imported) continue;
    const target = resolveModule(owner.filePath, imported.source, projectFiles);
    if (!target || target.filePath === owner.filePath) continue;
    const targetProgram = programOf(target.filePath, target.source);
    if (!targetProgram) continue;
    const targetFn = findNamedFunction(targetProgram, imported.imported === "*" ? callee : imported.imported)
      ?? findNamedFunction(targetProgram, callee);
    if (!targetFn) continue;

    const passThrough = forwardsDirectly(targetFn) && !containsGuardStatement(targetProgram, targetFn);
    const addsGuard = containsGuardStatement(targetProgram, targetFn);
    const targetImports = moduleImports(targetProgram);
    const next: DelegationNext[] = [];
    for (const second of collectCallees(targetProgram, targetFn).slice(0, SECOND_HOP_CAP)) {
      const secondImport = targetImports.find(({ local }) => local === second);
      const resolved = secondImport
        ? resolveModule(target.filePath, secondImport.source, projectFiles)
        : undefined;
      next.push({
        callee: second,
        targetModule: resolved?.filePath ?? null,
        importedFrom: secondImport?.source ?? null,
      });
    }
    hops.push({
      callee,
      targetModule: target.filePath,
      importedFrom: imported.source,
      passThrough,
      addsGuard,
      next,
    });
  }

  const chained = hops.filter((hop) => hop.next.length > 0);
  if (chained.length === 0) return undefined;
  const crossings = new Set<string>();
  for (const hop of chained) {
    crossings.add(hop.targetModule);
    for (const next of hop.next) {
      if (next.targetModule && next.targetModule !== hop.targetModule) {
        crossings.add(next.targetModule);
      }
    }
  }
  if (crossings.size < 2) return undefined;

  const reachesThirdModule = chained.some((hop) =>
    hop.next.some((next) => next.targetModule !== null && next.targetModule !== hop.targetModule)
  );

  return {
    function: {
      name,
      exported: isFunctionExported(program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    chain: {
      hops: chained,
      depth: reachesThirdModule ? 3 : 2,
      moduleCrossings: crossings.size,
      passThroughHops: chained.filter((hop) => hop.passThrough).length,
    },
  };
}
