import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Expression, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, RelatedProjectModule } from "./repository.js";

const MEMBERSHIP_METHODS = new Set(["includes", "indexOf", "startsWith", "endsWith", "has", "get"]);

export type NormalizationSite = {
  source: string;
  operator: string;
  normalizedSide: "left" | "right" | "receiver" | "argument" | "both" | "unknown";
  normalizer: string | null;
};

export type AsymmetricNormalizationEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  comparisons: NormalizationSite[];
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function normalizerIn(expression: Expression | undefined, source: string): string | null {
  if (!expression) return null;
  const text = nodeSource(expression, source);
  const match = [...text.matchAll(
    /\.\s*(toLowerCase|toUpperCase|trim|trimStart|trimEnd|normalize)\s*\(/g,
  )][0];
  return match?.[1] ?? null;
}

function calleeName(call: CallExpression): string | null {
  if (call.callee.type === "MemberExpression" && call.callee.property.type === "Identifier") {
    return call.callee.property.name;
  }
  return null;
}

export function buildAsymmetricNormalizationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): AsymmetricNormalizationEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const ownerSource = ownerFile.source;
  const nested = nestedFunctionRanges(parsed.program, fn);
  const comparisons: NormalizationSite[] = [];
  const normalizedBindings = new Map<string, string>();

  new Visitor({
    VariableDeclarator(node) {
      if (!containsNode(fn, node) || node.id.type !== "Identifier" || !node.init) return;
      const normalizer = normalizerIn(node.init, ownerSource);
      if (normalizer) normalizedBindings.set(node.id.name, normalizer);
    },
  }).visit(parsed.program);

  function operandNormalizer(expression: Expression): string | null {
    const direct = normalizerIn(expression, ownerSource);
    if (direct) return direct;
    if (expression.type === "Identifier") return normalizedBindings.get(expression.name) ?? null;
    return null;
  }

  new Visitor({
    BinaryExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.operator !== "==" && node.operator !== "===" && node.operator !== "!=" && node.operator !== "!==") {
        return;
      }
      const left = operandNormalizer(node.left);
      const right = operandNormalizer(node.right);
      if (!left && !right) return;
      comparisons.push({
        source: nodeSource(node, ownerFile.source),
        operator: node.operator,
        normalizedSide: left && right ? "both" : left ? "left" : "right",
        normalizer: left ?? right,
      });
    },
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      const name = calleeName(call);
      if (!name || !MEMBERSHIP_METHODS.has(name)) return;
      if (call.callee.type !== "MemberExpression") return;
      const receiver = operandNormalizer(call.callee.object);
      const args = call.arguments.map((argument) => {
        const value = argument.type === "SpreadElement" ? argument.argument : argument;
        return operandNormalizer(value);
      });
      const argumentNormalized = args.some(Boolean);
      if (!receiver && !argumentNormalized) return;
      comparisons.push({
        source: nodeSource(call, ownerFile.source),
        operator: name,
        normalizedSide: receiver && argumentNormalized
          ? "both"
          : receiver
            ? "receiver"
            : "argument",
        normalizer: receiver ?? args.find(Boolean) ?? null,
      });
    },
  }).visit(parsed.program);

  if (comparisons.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    comparisons,
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(candidate.filePath, parsed.program, projectFiles),
    },
  };
}
