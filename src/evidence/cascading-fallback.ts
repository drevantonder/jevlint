import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, CatchClause, Expression, Node, Program, TryStatement } from "oxc-parser";
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
} from "./repository.js";
import type {
  FunctionCaller,
  FunctionNode,
  RelatedProjectModule,
} from "./repository.js";

export type FallbackCall = {
  call: string;
  root: string | null;
  importedFrom: string | null;
};

export type RetryScope = "shrinking" | "same-size" | "unknown";

export type RetryFloorKind = "minimum-size" | "singleton" | "give-up";

export type RetryFloor = {
  kind: RetryFloorKind;
  detail: string;
};

export type RetryChainScope = {
  scope: RetryScope;
  detail: string;
};

export type SharedFallbackDependency = {
  root: string | null;
  importedFrom: string | null;
  primaryCall: string;
  fallbackCall: string;
  scope: RetryScope;
  scopeDetail: string;
  floors: RetryFloor[];
};

export type CascadingFallbackHandler = {
  primaryCalls: FallbackCall[];
  fallbackCalls: FallbackCall[];
  sharedDependencies: SharedFallbackDependency[];
  fallbackReturnsStatic: boolean;
};

export type CascadingFallbackEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  handlers: CascadingFallbackHandler[];
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function importSourceFor(
  root: string | null,
  imports: { source: string; local: string }[],
): string | null {
  if (!root) return null;
  return imports.find(({ local }) => local === root)?.source ?? null;
}

type CallSite = {
  info: FallbackCall;
  args: string[];
  node: CallExpression;
};

function callsWithin(
  range: NodeRange,
  program: Program,
  source: string,
  nested: NodeRange[],
  imports: { source: string; local: string }[],
): CallSite[] {
  const calls: CallSite[] = [];
  new Visitor({
    CallExpression(node: CallExpression) {
      if (!containsNode(range, node) || !belongsDirectlyToFunction(node, nested)) return;
      const root = calleeRootName(node.callee);
      calls.push({
        info: {
          call: nodeSource(node, source),
          root,
          importedFrom: importSourceFor(root, imports),
        },
        args: node.arguments.map((argument) => nodeSource(argument, source)),
        node,
      });
    },
  }).visit(program);
  return calls;
}

function fallbackReturnsStatic(
  handler: CatchClause,
  program: Program,
  source: string,
  nested: NodeRange[],
): boolean {
  let found = false;
  new Visitor({
    ReturnStatement(node) {
      if (!containsNode(handler.body, node) || !belongsDirectlyToFunction(node, nested)) return;
      const argument = node.argument;
      if (!argument) return;
      if (argument.type === "Literal" || argument.type === "TemplateLiteral") {
        found = true;
        return;
      }
      if (/cache|static|fallback|default/i.test(source.slice(argument.start, argument.end))) {
        found = true;
      }
    },
  }).visit(program);
  return found;
}

function flat(text: string): string {
  return text.replace(/\s+/g, "");
}

function staticMember(expression: Expression): { object: Expression; method: string } | null {
  if (expression.type !== "MemberExpression" || expression.computed) return null;
  if (expression.property.type !== "Identifier") return null;
  return { object: expression.object, method: expression.property.name };
}

const PAGED_SCOPE_NAME = /^(page|offset|cursor|limit|pageSize|chunk|batch|single|half|smaller|reduced)$/i;
const HALVED_NAME = /\bhal(f|ves|ving|ved)\b/i;

function shrinkDetail(primary: CallSite, fallback: CallSite, source: string): string | null {
  const primaryArgs = primary.args.map(flat);
  const primaryText = primaryArgs.join(",");
  const parameters = fallback.node.arguments;
  for (let index = 0; index < parameters.length; index += 1) {
    const argument = parameters[index];
    if (!argument || argument.type === "SpreadElement") continue;
    const text = nodeSource(argument, source);
    if (argument.type === "CallExpression") {
      const member = staticMember(argument.callee);
      if (member) {
        const objectSource = nodeSource(member.object, source);
        if (/^(slice|subarray|splice)$/.test(member.method) && primaryArgs.includes(flat(objectSource))) {
          return `fallback narrows ${objectSource} with .${member.method} where the primary passed it whole`;
        }
        if (member.method === "at" && primaryArgs.includes(flat(objectSource))) {
          return `fallback passes a single element ${text} where the primary passed ${objectSource} whole`;
        }
        const root = member.object.type === "Identifier" ? member.object.name : null;
        if (root === "Math" && /^(floor|ceil|round)$/.test(member.method)) {
          return `fallback derives a smaller size with Math.${member.method} (${text})`;
        }
      }
    }
    if (argument.type === "MemberExpression" && argument.computed) {
      const baseSource = nodeSource(argument.object, source);
      if (primaryArgs.includes(flat(baseSource))) {
        return `fallback passes a single element ${text} where the primary passed ${baseSource} whole`;
      }
    }
    if (argument.type === "BinaryExpression") {
      const rightValue = numericValue(argument.right);
      const halves = argument.operator === "/" && rightValue === 2;
      const shifts = (argument.operator === ">>" || argument.operator === ">>>") && rightValue === 1;
      if (halves || shifts) {
        return `fallback halves a size (${text}) where the primary passed it whole`;
      }
    }
    const fallbackValue = numericValue(argument);
    if (fallbackValue !== null) {
      const primaryArgument = primary.node.arguments[index];
      if (primaryArgument && primaryArgument.type !== "SpreadElement") {
        const primaryValue = numericValue(primaryArgument);
        if (primaryValue !== null && primaryValue > fallbackValue) {
          return `fallback reduces a numeric scope from ${nodeSource(primaryArgument, source)} to ${text}`;
        }
      }
    }
    if (
      argument.type === "Identifier"
      && PAGED_SCOPE_NAME.test(argument.name)
      && !primaryText.includes(flat(text))
    ) {
      return `fallback steps down to a paged or reduced scope (${text})`;
    }
  }
  if (HALVED_NAME.test(fallback.info.call) && !HALVED_NAME.test(primary.info.call)) {
    return `fallback names a halved scope (${fallback.info.call})`;
  }
  return null;
}

function numericValue(expression: Expression): number | null {
  if (expression.type !== "Literal") return null;
  if (!Number.isFinite(expression.value)) return null;
  // SAFETY: Number.isFinite passes only for finite numbers, so the literal holds a number here.
  return expression.value as number;
}

function scopeRelation(
  primary: CallSite,
  fallback: CallSite,
  source: string,
): RetryChainScope {
  const primaryArgs = primary.args.map(flat);
  const fallbackArgs = fallback.args.map(flat);
  if (
    primaryArgs.length === fallbackArgs.length
    && primaryArgs.every((argument, index) => argument === fallbackArgs[index])
  ) {
    return {
      scope: "same-size",
      detail: `fallback repeats the primary arguments unchanged (${fallback.info.call})`,
    };
  }
  const shrink = shrinkDetail(primary, fallback, source);
  if (shrink) return { scope: "shrinking", detail: shrink };
  return {
    scope: "unknown",
    detail: `fallback arguments (${fallback.args.join(", ") || "none"}) differ from primary arguments (${primary.args.join(", ") || "none"}) with no recognized shrink shape`,
  };
}

const SIZE_NAME = /^(size|count|length|batch|remaining|total|n|len|items|entries)$/i;
const BUDGET_NAME = /maxAttempts|maxRetries|attemptBudget|retryBudget|maxDepth/i;
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;

function isSizeSide(text: string): boolean {
  const flat = text.replace(/\s+/g, "");
  if (/\.length\b/.test(flat)) return true;
  return SIZE_NAME.test(flat);
}

function numericBound(expression: Expression): number | null {
  const value = numericValue(expression);
  if (value !== null) return value;
  if (expression.type === "Identifier" && CONSTANT_NAME.test(expression.name)) {
    return Number.NaN;
  }
  return null;
}

function retryFloors(
  fn: NodeRange,
  program: Program,
  source: string,
  nested: NodeRange[],
): RetryFloor[] {
  const floors: RetryFloor[] = [];
  const push = (kind: RetryFloorKind, detail: string): void => {
    if (floors.length >= 8) return;
    if (floors.some((floor) => floor.kind === kind && floor.detail === detail)) return;
    floors.push({ kind, detail });
  };
  const catchBodies: NodeRange[] = [];
  new Visitor({
    CatchClause(handler: CatchClause) {
      if (containsNode(fn, handler) && belongsDirectlyToFunction(handler, nested)) {
        catchBodies.push(handler.body);
      }
    },
  }).visit(program);
  new Visitor({
    BinaryExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const text = nodeSource(node, source);
      if (BUDGET_NAME.test(text)) {
        push("give-up", `attempt budget bounds the retry chain (${text})`);
        return;
      }
      if (!["<", "<=", "===", "!==", ">", ">="].includes(node.operator)) return;
      const leftIsSize = isSizeSide(nodeSource(node.left, source));
      const rightIsSize = isSizeSide(nodeSource(node.right, source));
      const bound = leftIsSize ? numericBound(node.right) : rightIsSize ? numericBound(node.left) : null;
      if (bound === null) return;
      if (bound === 1) {
        push("singleton", `singleton base case guards the retry chain (${text})`);
      } else {
        push("minimum-size", `minimum-size guard bounds the retry chain (${text})`);
      }
    },
    ThrowStatement(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (!catchBodies.some((body) => containsNode(body, node))) return;
      push("give-up", `throws instead of retrying (${nodeSource(node, source)})`);
    },
  }).visit(program);
  return floors;
}

function handlerEvidence(
  statement: TryStatement,
  handler: CatchClause,
  source: string,
  program: Program,
  nested: NodeRange[],
  imports: { source: string; local: string }[],
  floors: RetryFloor[],
): CascadingFallbackHandler {
  const primarySites = callsWithin(statement.block, program, source, nested, imports);
  const fallbackSites = callsWithin(handler.body, program, source, nested, imports);
  const sharedDependencies: SharedFallbackDependency[] = [];
  for (const fallback of fallbackSites) {
    const primary = primarySites.find((candidate) =>
      candidate.info.root !== null
      && candidate.info.root === fallback.info.root
      && candidate.info.importedFrom === fallback.info.importedFrom
    );
    if (primary && fallback.info.root !== null) {
      const retry = scopeRelation(primary, fallback, source);
      sharedDependencies.push({
        root: fallback.info.root,
        importedFrom: fallback.info.importedFrom,
        primaryCall: primary.info.call,
        fallbackCall: fallback.info.call,
        scope: retry.scope,
        scopeDetail: retry.detail,
        floors,
      });
    }
  }
  return {
    primaryCalls: primarySites.map((site) => site.info),
    fallbackCalls: fallbackSites.map((site) => site.info),
    sharedDependencies,
    fallbackReturnsStatic: fallbackReturnsStatic(handler, program, source, nested),
  };
}

export function buildCascadingFallbackEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): CascadingFallbackEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn: FunctionNode | undefined = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const imports = moduleImports(parsed.program);
  const floors = retryFloors(fn, parsed.program, ownerFile.source, nested);
  const handlers: CascadingFallbackHandler[] = [];
  new Visitor({
    TryStatement(statement: TryStatement) {
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
          parsed.program,
          nested,
          imports,
          floors,
        ));
      }
    },
  }).visit(parsed.program);
  const withFallbackCalls = handlers.filter(({ fallbackCalls }) => fallbackCalls.length > 0);
  if (withFallbackCalls.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    handlers: withFallbackCalls,
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
