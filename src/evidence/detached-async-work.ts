import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Expression, NewExpression, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  calleeRootName,
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type {
  FunctionCaller,
  FunctionNode,
  RelatedProjectModule,
} from "./repository.js";

type DetachedCallEvidence = {
  expression: string;
  callee: string;
  kind: "bare-statement" | "stored-unawaited" | "promise-executor";
  asyncness: "confirmed" | "possible";
  asyncnessReason: string;
  importedFrom: string | null;
  storedAs: string | null;
};

export type DetachedAsyncWorkEvidence = {
  function: {
    name: string | null;
    async: boolean;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  detached: DetachedCallEvidence[];
  enclosingMayReturnPromise: boolean;
  moduleHasRejectionGuard: boolean;
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

const SYNC_ROOTS = new Set(["console", "Math", "JSON"]);

const HANDLER_METHODS = new Set(["then", "catch", "finally"]);

function isHandledTail(call: CallExpression): boolean {
  const callee = call.callee;
  if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier") return false;
  if (!HANDLER_METHODS.has(callee.property.name)) return false;
  return containsCall(callee.object);
}

function containsCall(expression: Expression): boolean {
  if (expression.type === "CallExpression") return true;
  if (expression.type === "ChainExpression") return containsCall(expression.expression);
  if (expression.type === "MemberExpression") return containsCall(expression.object);
  return false;
}

function directStatementCall(
  expression: Expression,
): CallExpression | undefined {
  const value = expression.type === "ChainExpression" ? expression.expression : expression;
  if (value.type === "AwaitExpression") return undefined;
  if (value.type === "UnaryExpression") return undefined;
  if (value.type !== "CallExpression") return undefined;
  if (isHandledTail(value)) return undefined;
  return value;
}

type StoredPromise = {
  name: string;
  call: CallExpression;
};

function storedPromises(fn: FunctionNode, program: Program, nested: NodeRange[]): StoredPromise[] {
  const stored: StoredPromise[] = [];
  new Visitor({
    VariableDeclarator(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.id.type !== "Identifier" || !node.init) return;
      const init = node.init.type === "ChainExpression" ? node.init.expression : node.init;
      if (init.type !== "CallExpression" || isHandledTail(init)) return;
      stored.push({ name: node.id.name, call: init });
    },
  }).visit(program);
  return stored;
}

function trackedNames(fn: FunctionNode, program: Program, nested: NodeRange[]): Set<string> {
  const tracked = new Set<string>();
  const observed: NodeRange[] = [];
  new Visitor({
    AwaitExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      observed.push(node);
    },
    ReturnStatement(node) {
      if (!node.argument || !containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) {
        return;
      }
      observed.push(node.argument);
    },
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      const callee = call.callee;
      if (
        callee.type === "MemberExpression"
        && callee.property.type === "Identifier"
        && HANDLER_METHODS.has(callee.property.name)
        && callee.object.type === "Identifier"
      ) tracked.add(callee.object.name);
    },
    Identifier(node) {
      if (!belongsDirectlyToFunction(node, nested)) return;
      if (observed.some((range) => containsNode(range, node))) tracked.add(node.name);
    },
  }).visit(program);
  return tracked;
}

type Asyncness = {
  certainty: "confirmed" | "possible";
  reason: string;
  importedFrom: string | null;
};

function declarationAsyncness(
  program: Program,
  name: string,
): boolean {
  let found = false;
  new Visitor({
    FunctionDeclaration(node) {
      if (!found && node.id?.name === name && node.async) found = true;
    },
    VariableDeclarator(node) {
      if (
        !found
        && node.id.type === "Identifier"
        && node.id.name === name
        && node.init
        && (node.init.type === "ArrowFunctionExpression" || node.init.type === "FunctionExpression")
        && node.init.async
      ) found = true;
    },
  }).visit(program);
  return found;
}

function calleeAsyncness(
  call: CallExpression,
  ownerPath: string,
  program: Program,
  projectFiles: ProjectFile[],
): Asyncness | undefined {
  const root = calleeRootName(call.callee);
  if (!root || SYNC_ROOTS.has(root)) return undefined;
  if (declarationAsyncness(program, root)) {
    return { certainty: "confirmed", reason: `same-module async function ${root}`, importedFrom: null };
  }
  const imports = moduleImports(program);
  const imported = imports.find(({ local }) => local === root);
  if (!imported) {
    return {
      certainty: "possible",
      reason: `callee ${root} is not declared in the module so promise return is unresolved`,
      importedFrom: null,
    };
  }
  const target = resolveModule(ownerPath, imported.source, projectFiles);
  if (!target) {
    return {
      certainty: "possible",
      reason: `callee ${root} comes from external package ${imported.source} with no local signature`,
      importedFrom: imported.source,
    };
  }
  const parsed = parseCached(target.filePath, target.source);
  if (parsed.errors.some((error) => error.severity === "Error")) {
    return {
      certainty: "possible",
      reason: `callee ${root} target module does not parse so its signature is unresolved`,
      importedFrom: imported.source,
    };
  }
  if (declarationAsyncness(parsed.program, imported.imported)) {
    return {
      certainty: "confirmed",
      reason: `imported async function ${imported.imported} from ${imported.source}`,
      importedFrom: imported.source,
    };
  }
  return {
    certainty: "possible",
    reason: `imported ${imported.imported} from ${imported.source} has no resolvable async signature`,
    importedFrom: imported.source,
  };
}

function executorSettlement(
  executor: NewExpression["arguments"][number] | undefined,
  source: string,
): { conditional: boolean; detail: string } | undefined {
  if (
    !executor
    || (executor.type !== "ArrowFunctionExpression" && executor.type !== "FunctionExpression")
  ) return undefined;
  const parameters = executor.params
    .map((parameter) => parameter.type === "Identifier" ? parameter.name : null)
    .filter((name): name is string => name !== null);
  if (parameters.length === 0) {
    return { conditional: true, detail: "executor takes no settlement callbacks" };
  }
  if (executor.body === null) {
    return { conditional: true, detail: "executor body is empty so nothing settles the promise" };
  }
  const bodySource = source.slice(executor.body.start, executor.body.end);
  const settlements = parameters.filter((name) => bodySource.includes(`${name}(`));
  if (settlements.length === 0) {
    return { conditional: true, detail: "executor never invokes its settlement callbacks" };
  }
  return {
    conditional: true,
    detail: `settlement through ${settlements.join(", ")} cannot be verified structurally`,
  };
}

function rejectionGuardPresent(program: Program): boolean {
  let present = false;
  new Visitor({
    CallExpression(call) {
      if (present) return;
      const source = call.callee;
      if (
        source.type === "MemberExpression"
        && source.object.type === "Identifier"
        && source.object.name === "process"
        && source.property.type === "Identifier"
        && source.property.name === "on"
      ) present = call.arguments.some((argument) =>
        argument.type === "Literal" && argument.value === "unhandledRejection"
      );
    },
  }).visit(program);
  return present;
}

function enclosingMayReturnPromise(fn: FunctionNode, program: Program): boolean {
  if (fn.async) return true;
  let found = false;
  const nested = nestedFunctionRanges(program, fn);
  new Visitor({
    ReturnStatement(node) {
      if (found || !containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.argument?.type === "CallExpression" || node.argument?.type === "NewExpression") {
        found = true;
      }
    },
  }).visit(program);
  return found;
}

export function buildDetachedAsyncWorkEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DetachedAsyncWorkEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const tracked = trackedNames(fn, parsed.program, nested);
  const detached: DetachedCallEvidence[] = [];
  const source = ownerFile.source;

  new Visitor({
    ExpressionStatement(statement) {
      if (!containsNode(fn, statement) || !belongsDirectlyToFunction(statement, nested)) return;
      const call = directStatementCall(statement.expression);
      if (!call) return;
      const asyncness = calleeAsyncness(
        call,
        ownerFile.filePath,
        parsed.program,
        projectFiles,
      );
      if (!asyncness) return;
      detached.push({
        expression: source.slice(call.start, call.end),
        callee: source.slice(call.callee.start, call.callee.end),
        kind: "bare-statement",
        asyncness: asyncness.certainty,
        asyncnessReason: asyncness.reason,
        importedFrom: asyncness.importedFrom,
        storedAs: null,
      });
    },
    NewExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const callee = node.callee;
      if (callee.type !== "Identifier" || callee.name !== "Promise") return;
      const settlement = executorSettlement(node.arguments[0], source);
      if (!settlement) return;
      detached.push({
        expression: source.slice(node.start, node.end),
        callee: "Promise",
        kind: "promise-executor",
        asyncness: "confirmed",
        asyncnessReason: settlement.detail,
        importedFrom: null,
        storedAs: null,
      });
    },
  }).visit(parsed.program);

  for (const { name, call } of storedPromises(fn, parsed.program, nested)) {
    if (tracked.has(name)) continue;
    const asyncness = calleeAsyncness(call, ownerFile.filePath, parsed.program, projectFiles);
    if (!asyncness) continue;
    detached.push({
      expression: source.slice(call.start, call.end),
      callee: source.slice(call.callee.start, call.callee.end),
      kind: "stored-unawaited",
      asyncness: asyncness.certainty,
      asyncnessReason: `${asyncness.reason}; stored as ${name} without await or return`,
      importedFrom: asyncness.importedFrom,
      storedAs: name,
    });
  }

  if (detached.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      async: fn.async,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    detached,
    enclosingMayReturnPromise: enclosingMayReturnPromise(fn, parsed.program),
    moduleHasRejectionGuard: rejectionGuardPresent(parsed.program),
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
