import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode } from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findDirectFunction,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionNode } from "./repository.js";

export type NegationSite = {
  source: string;
  layers: number;
  wrapsNegativeName: boolean;
  negativeName: string | null;
  kind: "bang-stack" | "equality-against-boolean" | "inverted-polarity-call";
};

export type DoubleNegationEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  negations: NegationSite[];
  maxLayers: number;
};

const NEGATIVE_NAME_PATTERN =
  /^(no|not|non|never|without|disable[d]?|un|in|im|il|ir|dis|anti|missing|exclude[d]?|omit|deny|denied|block[ed]?|prevent|hide|hidden|suppress|skip|mute[d]?|opt_?out)/i;

const NEGATIVE_PARAM_PATTERN =
  /^(no|not|non|never|without|disable[d]?|exclude[d]?|hide|hidden|suppress|skip|deny)/i;

function isBooleanLiteral(expression: Expression): boolean {
  if (expression.type === "Literal") {
    return expression.value === false || expression.value === null;
  }
  return expression.type === "Identifier" && (expression.name === "false" || expression.name === "null");
}

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function bangLayers(expression: Expression) {
  let depth = 0;
  let current: Expression = expression;
  while (current.type === "UnaryExpression" && current.operator === "!") {
    depth += 1;
    current = current.argument;
  }
  return { depth, inner: current };
}

function innerNegativeName(inner: Expression): string | null {
  if (inner.type !== "Identifier") return null;
  const bare = inner.name.replace(/^(is|has|can|should|will|does)(?=[A-Z])/, "");
  return NEGATIVE_NAME_PATTERN.test(inner.name) || NEGATIVE_NAME_PATTERN.test(bare)
    ? inner.name
    : null;
}

function bindingName(parameter: FunctionNode["params"][number]): string | undefined {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "Identifier") return value.name;
  if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
    return value.left.name;
  }
  if (value.type === "ObjectPattern") {
    return undefined;
  }
  return undefined;
}

export function buildDoubleNegationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DoubleNegationEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn: FunctionNode | undefined = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested: NodeRange[] = [];
  new Visitor({
    ArrowFunctionExpression(node) {
      if (node !== fn && containsNode(fn, node)) nested.push(node);
    },
    FunctionDeclaration(node) {
      if (node !== fn && containsNode(fn, node)) nested.push(node);
    },
    FunctionExpression(node) {
      if (node !== fn && containsNode(fn, node)) nested.push(node);
    },
  }).visit(parsed.program);

  const negations: NegationSite[] = [];

  new Visitor({
    UnaryExpression(node) {
      if (node.operator !== "!") return;
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const { inner } = bangLayers(node);
      const negativeName = innerNegativeName(inner);
      const layers = (() => {
        let count = 0;
        let current: Expression = node;
        while (current.type === "UnaryExpression" && current.operator === "!") {
          count += 1;
          current = current.argument;
        }
        return count;
      })();
      negations.push({
        source: nodeSource(node, ownerFile.source).slice(0, 200),
        layers,
        wrapsNegativeName: negativeName !== null,
        negativeName,
        kind: "bang-stack",
      });
    },
    BinaryExpression(node) {
      if (node.operator !== "!=" && node.operator !== "!==" && node.operator !== "==" && node.operator !== "===") {
        return;
      }
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const literalSide = isBooleanLiteral(node.left) ? node.left : isBooleanLiteral(node.right) ? node.right : null;
      if (!literalSide) return;
      negations.push({
        source: nodeSource(node, ownerFile.source).slice(0, 200),
        layers: 1,
        wrapsNegativeName: false,
        negativeName: null,
        kind: "equality-against-boolean",
      });
    },
  }).visit(parsed.program);

  const negativeParams = new Set<string>();
  for (const parameter of fn.params) {
    const name = bindingName(parameter);
    if (name && NEGATIVE_PARAM_PATTERN.test(name)) negativeParams.add(name);
  }
  if (negativeParams.size > 0) {
    new Visitor({
      CallExpression(node) {
        if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
        for (const argument of node.arguments) {
          const value = argument.type === "SpreadElement" ? argument.argument : argument;
          if (value.type !== "UnaryExpression" || value.operator !== "!") continue;
          if (value.argument.type !== "Identifier" || !negativeParams.has(value.argument.name)) continue;
          negations.push({
            source: nodeSource(node, ownerFile.source).slice(0, 200),
            layers: 2,
            wrapsNegativeName: true,
            negativeName: value.argument.name,
            kind: "inverted-polarity-call",
          });
        }
      },
    }).visit(parsed.program);
  }

  const deduped = new Map<string, NegationSite>();
  for (const site of negations) {
    const key = `${site.kind}:${site.source}`;
    const existing = deduped.get(key);
    if (!existing || existing.layers < site.layers) deduped.set(key, site);
  }

  const stacked = [...deduped.values()].filter((site) => {
    if (site.kind !== "bang-stack") return true;
    return site.layers >= 2 || site.wrapsNegativeName;
  });
  if (stacked.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    negations: stacked.slice(0, 10),
    maxLayers: Math.max(...stacked.map((site) => site.layers)),
  };
}
