import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CatchClause, Node, Program, TryStatement } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type {
  FunctionCaller,
  FunctionNode,
  RelatedProjectModule,
} from "./repository.js";

type ErrorHandlerEvidence = {
  caught: string | null;
  usesCaughtError: boolean;
  tryBlock: string;
  catchBody: string;
  finallyBlock: string | null;
  throws: string[];
  returns: string[];
  calls: string[];
  controlTransfers: string[];
  continuationAfterTry: string;
  /** Source of the guard test that narrows the catch to the absence family, if any. */
  absenceGuard: string | null;
  /** Whether the catch examines the error kind before silencing it. */
  guardsAbsenceKind: boolean;
  /** Catch returns of an empty collection literal (e.g. `return [];`). */
  emptyReturns: string[];
  /** Return or record carrying the caught error forward as reason data, if any. */
  surfacedReason: string | null;
  /** Stderr-streaming calls in the catch (console.error/warn, process.stderr.write). */
  stderrWrites: string[];
  /** Statements flipping a completeness/success flag to false in the catch. */
  completenessFlips: string[];
};

export type SwallowedErrorEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  handlers: ErrorHandlerEvidence[];
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

function caughtName(handler: CatchClause, source: string): string | null {
  return handler.param ? source.slice(handler.param.start, handler.param.end) : null;
}

function usesCaughtIdentifier(
  handler: CatchClause,
  program: Program,
  nested: NodeRange[],
): boolean {
  if (!handler.param || handler.param.type !== "Identifier") return false;
  const name = handler.param.name;
  let used = false;
  new Visitor({
    Identifier(node) {
      if (
        node.name === name
        && containsNode(handler.body, node)
        && belongsDirectlyToFunction(node, nested)
      ) used = true;
    },
  }).visit(program);
  return used;
}

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

/**
 * Absence-family error kinds: the target vanished between observation and use
 * (removed file, dangling symlink, unmounted path, vanished socket). Silence
 * for these kinds is correct handling, not omission. Enumerated here so the
 * judgment can tell a vanished path from a real breakdown.
 */
const ABSENCE_CODES = ["ENOENT", "ENOTDIR", "ELOOP"] as const;

/** Not-found-shaped guard spellings beyond raw codes, matched against guard tests. */
const NOT_FOUND_GUARD = /not-?found|absence|isMissing/i;
const NOT_FOUND_CLASS = /NotFound|A(no)?Such|Absence/i;
const NOT_FOUND_STATUS = /\bstatus(Code)?\b[^;]*?===?\s*404/;
const STDERR_SINKS = ["console.error", "console.warn", "process.stderr.write"] as const;
/** Log calls record for humans, not for callers; they never count as carrying the reason. */
const LOG_CALL = /(^|\.)log(ger)?\.[A-Za-z_$][\w$]*$|^console\.(log|info|debug|trace)$/;
const COMPLETENESS_FLAG = /\b(complete|completed|success|successful|ok|allClear)\b/i;
const REASON_KEYS = new Set(["reason", "cause", "error", "failure"]);

function mentionsName(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(text);
}

function testGuardsAbsence(testSource: string, caught: string | null): boolean {
  if (ABSENCE_CODES.some((code) => testSource.includes(`"${code}"`) || testSource.includes(`'${code}'`))) {
    return true;
  }
  if (!caught || !mentionsName(testSource, caught)) return false;
  if (NOT_FOUND_GUARD.test(testSource)) return true;
  if (/\binstanceof\b/.test(testSource) && NOT_FOUND_CLASS.test(testSource)) return true;
  return NOT_FOUND_STATUS.test(testSource);
}

function findAbsenceGuard(
  handler: CatchClause,
  program: Program,
  nested: NodeRange[],
  caught: string | null,
  source: string,
): string | null {
  let guard: string | null = null;
  new Visitor({
    IfStatement(node) {
      if (guard || !containsNode(handler.body, node) || !belongsDirectlyToFunction(node, nested)) {
        return;
      }
      const testSource = nodeSource(node.test, source);
      if (testGuardsAbsence(testSource, caught)) guard = testSource;
    },
  }).visit(program);
  return guard;
}

function isEmptyLiteral(argumentSource: string): boolean {
  const text = argumentSource.trim();
  return text === "[]" || text === "{}" || text === '""' || text === "''" || text === "``";
}

function valueCarriesCaught(valueSource: string, caught: string | null, reasonNames: Set<string>): boolean {
  if (!caught) return false;
  if (mentionsName(valueSource, caught)) return true;
  for (const name of reasonNames) {
    if (mentionsName(valueSource, name)) return true;
  }
  return false;
}

function objectCarriesReason(
  expression: Node,
  caught: string | null,
  reasonNames: Set<string>,
  source: string,
): boolean {
  if (expression.type !== "ObjectExpression") return false;
  for (const property of expression.properties) {
    if (property.type !== "Property" || property.kind !== "init") continue;
    const key = property.key;
    const keyName = key.type === "Identifier"
      ? key.name
      : key.type === "Literal"
        ? nodeSource(key, source).replace(/^['"]|['"]$/g, "")
        : null;
    if (!keyName || !REASON_KEYS.has(keyName)) continue;
    if (valueCarriesCaught(nodeSource(property.value, source), caught, reasonNames)) return true;
  }
  return false;
}

function collectReasonNames(
  handler: CatchClause,
  program: Program,
  nested: NodeRange[],
  caught: string | null,
  source: string,
): Set<string> {
  const names = new Set<string>();
  if (!caught) return names;
  new Visitor({
    VariableDeclarator(node) {
      if (!containsNode(handler.body, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.id.type !== "Identifier" || !node.init) return;
      if (mentionsName(nodeSource(node.init, source), caught)) names.add(node.id.name);
    },
  }).visit(program);
  return names;
}

function findSurfacedReason(
  handler: CatchClause,
  program: Program,
  nested: NodeRange[],
  caught: string | null,
  reasonNames: Set<string>,
  source: string,
): string | null {
  let surfaced: string | null = null;
  new Visitor({
    ReturnStatement(node) {
      if (surfaced || !node.argument || !containsNode(handler.body, node)) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      if (objectCarriesReason(node.argument, caught, reasonNames, source)) {
        surfaced = nodeSource(node, source);
      }
    },
    CallExpression(node) {
      if (surfaced || !containsNode(handler.body, node)) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      const callee = node.callee;
      if ((callee.type === "MemberExpression" || callee.type === "Identifier") && LOG_CALL.test(nodeSource(callee, source))) {
        return;
      }
      for (const argument of node.arguments) {
        if (argument.type !== "SpreadElement" && objectCarriesReason(argument, caught, reasonNames, source)) {
          surfaced = nodeSource(node, source);
          return;
        }
      }
    },
  }).visit(program);
  return surfaced;
}

function findStderrWrites(
  handler: CatchClause,
  program: Program,
  nested: NodeRange[],
  source: string,
): string[] {
  const writes: string[] = [];
  new Visitor({
    CallExpression(node) {
      if (!containsNode(handler.body, node) || !belongsDirectlyToFunction(node, nested)) return;
      const callee = node.callee;
      const calleeSource = callee.type === "MemberExpression" || callee.type === "Identifier"
        ? nodeSource(callee, source)
        : null;
      if (calleeSource && STDERR_SINKS.some((sink) => sink === calleeSource)) {
        writes.push(nodeSource(node, source));
      }
    },
  }).visit(program);
  return writes;
}

function findCompletenessFlips(
  handler: CatchClause,
  program: Program,
  nested: NodeRange[],
  source: string,
): string[] {
  const flips: string[] = [];
  new Visitor({
    AssignmentExpression(node) {
      if (node.operator !== "=" || !containsNode(handler.body, node)) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      if (COMPLETENESS_FLAG.test(nodeSource(node.left, source)) && nodeSource(node.right, source).trim() === "false") {
        flips.push(nodeSource(node, source));
      }
    },
  }).visit(program);
  return flips;
}

function handlerEvidence(
  statement: TryStatement,
  handler: CatchClause,
  source: string,
  owner: FunctionNode,
  program: Program,
  nested: NodeRange[],
): ErrorHandlerEvidence {
  const throws: string[] = [];
  const returns: string[] = [];
  const emptyReturns: string[] = [];
  const calls: string[] = [];
  const controlTransfers: string[] = [];
  new Visitor({
    ThrowStatement(node) {
      if (containsNode(handler.body, node) && belongsDirectlyToFunction(node, nested)) {
        throws.push(nodeSource(node, source));
      }
    },
    ReturnStatement(node) {
      if (containsNode(handler.body, node) && belongsDirectlyToFunction(node, nested)) {
        returns.push(nodeSource(node, source));
        if (node.argument && isEmptyLiteral(nodeSource(node.argument, source))) {
          emptyReturns.push(nodeSource(node, source));
        }
      }
    },
    CallExpression(node) {
      if (containsNode(handler.body, node) && belongsDirectlyToFunction(node, nested)) {
        calls.push(nodeSource(node, source));
      }
    },
    BreakStatement(node) {
      if (containsNode(handler.body, node) && belongsDirectlyToFunction(node, nested)) {
        controlTransfers.push(nodeSource(node, source));
      }
    },
    ContinueStatement(node) {
      if (containsNode(handler.body, node) && belongsDirectlyToFunction(node, nested)) {
        controlTransfers.push(nodeSource(node, source));
      }
    },
  }).visit(program);

  const caught = caughtName(handler, source);
  const absenceGuard = findAbsenceGuard(handler, program, nested, caught, source);
  const reasonNames = collectReasonNames(handler, program, nested, caught, source);

  return {
    caught,
    usesCaughtError: usesCaughtIdentifier(handler, program, nested),
    tryBlock: nodeSource(statement.block, source),
    catchBody: nodeSource(handler.body, source),
    finallyBlock: statement.finalizer ? nodeSource(statement.finalizer, source) : null,
    throws,
    returns,
    calls,
    controlTransfers,
    continuationAfterTry: source.slice(statement.end, owner.end),
    absenceGuard,
    guardsAbsenceKind: absenceGuard !== null,
    emptyReturns,
    surfacedReason: findSurfacedReason(handler, program, nested, caught, reasonNames, source),
    stderrWrites: findStderrWrites(handler, program, nested, source),
    completenessFlips: findCompletenessFlips(handler, program, nested, source),
  };
}

export function buildSwallowedErrorEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): SwallowedErrorEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const handlers: ErrorHandlerEvidence[] = [];
  new Visitor({
    TryStatement(statement) {
      if (
        statement.handler
        && statement.start >= fn.start
        && statement.end <= fn.end
        && belongsDirectlyToFunction(statement, nested)
      ) {
        handlers.push(handlerEvidence(
          statement,
          statement.handler,
          ownerFile.source,
          fn,
          parsed.program,
          nested,
        ));
      }
    },
  }).visit(parsed.program);
  if (handlers.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    handlers,
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
