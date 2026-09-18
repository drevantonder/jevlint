import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Argument, ArrayExpressionElement, CallExpression, Expression, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode, nestedFunctionRanges } from "./function-scope.js";
import {
  calleeRootName,
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, RelatedProjectModule } from "./repository.js";

export type CombinatorKind = "all" | "race" | "any" | "allSettled";

export type PromiseCombinator = {
  source: string;
  combinator: CombinatorKind;
  legs: string[];
  heterogeneous: boolean;
  perLegCapture: boolean;
  resourceLegs: boolean;
  continuation: string;
  perLegConsumption: boolean;
  cleanupPresent: boolean;
  line: number;
};

export type PromiseCombinatorMismatchEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  combinators: PromiseCombinator[];
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

const RESOURCE_LEG_PATTERN = /connect|client|conn\b|lock|mutex|write|send|publish|transaction|subscribe/i;
const PER_LEG_USE_PATTERN = /\[\s*[A-Za-z_$]|\[\s*\d+\s*\]|\)\s*\.\s*status|\.\s*status\b|\.\s*value\b|\.\s*reason\b/;
const CLEANUP_PATTERN = /AbortController|AbortSignal|\.abort\s*\(|\.cancel\s*\(|clearTimeout|finally/i;

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function combinatorOf(call: CallExpression): CombinatorKind | undefined {
  const callee = call.callee.type === "ChainExpression" ? call.callee.expression : call.callee;
  if (
    callee.type !== "MemberExpression"
    || callee.object.type !== "Identifier"
    || callee.object.name !== "Promise"
    || callee.property.type !== "Identifier"
  ) return undefined;
  const method = callee.property.name;
  if (method === "all") return "all";
  if (method === "race") return "race";
  if (method === "any") return "any";
  if (method === "allSettled") return "allSettled";
  return undefined;
}

function withoutSpread(node: Argument | ArrayExpressionElement): Expression | null {
  if (!node) return null;
  return node.type === "SpreadElement" ? node.argument : node;
}

function legArguments(call: CallExpression): Expression[] {
  const first = call.arguments[0];
  const raw: (Argument | ArrayExpressionElement)[] = first?.type === "ArrayExpression"
    ? [...first.elements]
    : [...call.arguments];
  const legs: Expression[] = [];
  for (const item of raw) {
    const leg = withoutSpread(item);
    if (leg) legs.push(leg);
  }
  return legs;
}

function legCalleeRoots(leg: Expression): string[] {
  const roots = new Set<string>();
  const visit = (node: Expression): void => {
    if (node.type === "CallExpression") {
      const root = calleeRootName(node.callee);
      if (root) roots.add(root);
      for (const argument of node.arguments) {
        const leg = withoutSpread(argument);
        if (leg) visit(leg);
      }
      return;
    }
    if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") return;
    if (node.type === "MemberExpression") {
      visit(node.object);
      return;
    }
    if (node.type === "AwaitExpression") {
      visit(node.argument);
    }
  };
  visit(leg);
  return [...roots];
}

export function buildPromiseCombinatorMismatchEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): PromiseCombinatorMismatchEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const nested = nestedFunctionRanges(parsed.program, fn);
  const source = ownerFile.source;

  const inScope = (node: Node): boolean =>
    containsNode(fn, node) && belongsDirectlyToFunction(node, nested);

  const combinators: PromiseCombinator[] = [];

  const isDestructured = (call: CallExpression): boolean => {
    let found = false;
    new Visitor({
      VariableDeclarator(declarator) {
        if (found || !declarator.init || !inScope(declarator)) return;
        if (
          containsNode(declarator.init, call)
          && declarator.id.type === "ArrayPattern"
        ) found = true;
      },
    }).visit(parsed.program);
    return found;
  };

  new Visitor({
    CallExpression(call) {
      if (!inScope(call)) return;
      const combinator = combinatorOf(call);
      if (!combinator) return;
      const legs = legArguments(call);
      if (legs.length === 0) return;
      const legSources = legs.map((leg) => nodeSource(leg, source).slice(0, 500));
      const roots = new Set(legs.flatMap((leg) => legCalleeRoots(leg)));
      const legText = legs.map((leg) => nodeSource(leg, source)).join("\n");
      const continuation = source.slice(call.end, fn.end).slice(0, 2000);
      combinators.push({
        source: nodeSource(call, source).slice(0, 800),
        combinator,
        legs: legSources,
        heterogeneous: roots.size > 1,
        perLegCapture: combinator === "allSettled" || /\.catch\s*\(/.test(legText),
        resourceLegs: RESOURCE_LEG_PATTERN.test(legText),
        continuation,
        perLegConsumption: isDestructured(call) || PER_LEG_USE_PATTERN.test(continuation),
        cleanupPresent: CLEANUP_PATTERN.test(source),
        line: lineAt(source, call.start),
      });
    },
  }).visit(parsed.program);
  if (combinators.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: source.slice(0, 16_000),
    },
    combinators,
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(candidate.filePath, parsed.program, projectFiles),
    },
  };
}
