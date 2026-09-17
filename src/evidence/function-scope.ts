import { Visitor } from "oxc-parser";
import type { Program } from "oxc-parser";
import type { FunctionNode } from "./repository.js";

export type NodeRange = {
  start: number;
  end: number;
};

export function containsNode(outer: NodeRange, inner: NodeRange): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

export function nestedFunctionRanges(
  program: Program,
  owner: FunctionNode,
): NodeRange[] {
  const ranges: NodeRange[] = [];
  const add = (node: FunctionNode): void => {
    if (node !== owner && containsNode(owner, node)) {
      ranges.push({ start: node.start, end: node.end });
    }
  };
  new Visitor({
    ArrowFunctionExpression: add,
    FunctionDeclaration: add,
    FunctionExpression: add,
  }).visit(program);
  return ranges;
}

export function belongsDirectlyToFunction(
  node: NodeRange,
  nested: NodeRange[],
): boolean {
  return !nested.some((range) => containsNode(range, node));
}
