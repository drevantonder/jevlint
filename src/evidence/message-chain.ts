import { parseSync, Visitor } from "oxc-parser";
import type { Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type ChainLink = {
  text: string;
  isCall: boolean;
  hasArguments: boolean;
  argumentCount: number;
};

export type MessageChain = {
  text: string;
  links: ChainLink[];
  depth: number;
  pureNavigation: boolean;
  line: number;
};

export type MessageChainEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  chains: MessageChain[];
  repeatedPrefixes: { prefix: string; count: number }[];
  importedSources: string[];
  directAccessor: string | null;
  callers: FunctionCaller[];
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function unwrapped(expression: Expression): Expression {
  return expression.type === "ChainExpression" ? unwrapped(expression.expression) : expression;
}

function flattenChain(expression: Expression, source: string): { root: string; links: ChainLink[] } | undefined {
  const target = unwrapped(expression);
  if (target.type === "CallExpression") {
    const rawCallee = unwrapped(target.callee);
    if (rawCallee.type === "MemberExpression") {
      const inner = flattenChain(rawCallee.object, source);
      if (!inner) return undefined;
      return {
        root: inner.root,
        links: [...inner.links, {
          text: source.slice(rawCallee.property.start, rawCallee.property.end),
          isCall: true,
          hasArguments: target.arguments.length > 0,
          argumentCount: target.arguments.length,
        }],
      };
    }
    if (rawCallee.type === "Identifier") {
      return {
        root: rawCallee.name,
        links: [{
          text: rawCallee.name,
          isCall: true,
          hasArguments: target.arguments.length > 0,
          argumentCount: target.arguments.length,
        }],
      };
    }
    return undefined;
  }
  if (target.type === "MemberExpression") {
    const inner = flattenChain(target.object, source);
    if (!inner) return undefined;
    return {
      root: inner.root,
      links: [...inner.links, {
        text: source.slice(target.property.start, target.property.end),
        isCall: false,
        hasArguments: false,
        argumentCount: 0,
      }],
    };
  }
  if (target.type === "Identifier") {
    return { root: target.name, links: [{ text: target.name, isCall: false, hasArguments: false, argumentCount: 0 }] };
  }
  return undefined;
}

export function buildMessageChainEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): MessageChainEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const chains: MessageChain[] = [];

  new Visitor({
    CallExpression(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (nested.some((range) => range.start <= node.start && range.end >= node.end)) return;
      const flattened = flattenChain(node, owner.source);
      if (!flattened || flattened.links.length < 3) return;
      if (flattened.links.filter((link) => link.isCall).length < 2) return;
      const text = owner.source.slice(node.start, node.end);
      if (text.length > 300) return;
      if (chains.some((chain) => chain.text === text)) return;
      const navigational = flattened.links.slice(0, -1);
      chains.push({
        text,
        links: flattened.links,
        depth: flattened.links.length,
        pureNavigation: navigational.every((link) => !link.hasArguments),
        line: lineAt(owner.source, node.start),
      });
    },
  }).visit(parsed.program);

  if (chains.length === 0) return undefined;
  const maximal = chains.filter((chain) =>
    !chains.some((other) => other !== chain && other.text.includes(chain.text) && other.text !== chain.text)
  );
  maximal.sort((left, right) => right.depth - left.depth);

  const prefixCounts = new Map<string, number>();
  for (const chain of maximal) {
    const prefix = chain.links.slice(0, 2).map((link) => link.text).join(".");
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }
  const repeatedPrefixes = [...prefixCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([prefix, count]) => ({ prefix, count }))
    .slice(0, 8);

  const deepest = maximal[0];
  const finalLink = deepest?.links[deepest.links.length - 1]?.text;
  const directAccessor = finalLink
    ? new RegExp(`\\b${finalLink.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`).test(
      owner.source.slice(0, Math.max(candidate.start - 4000, 0)),
    )
      ? finalLink
      : null
    : null;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    chains: maximal.slice(0, 10),
    repeatedPrefixes,
    importedSources: [...new Set(moduleImports(parsed.program).map(({ source }) => source))].slice(0, 12),
    directAccessor,
    callers: findFunctionCallers(owner.filePath, name, projectFiles),
  };
}
