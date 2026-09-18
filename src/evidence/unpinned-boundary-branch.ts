import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression, Node, PrivateIdentifier } from "oxc-parser";
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
import { findTransitiveTestPins, type TransitivePin } from "./test-scope.js";

export type BoundaryBranchKind = "comparison" | "equality-tier" | "rounding";

export type BoundaryBranch = {
  source: string;
  line: number;
  kind: BoundaryBranchKind;
  predicate: string;
};

export type UnpinnedBoundaryBranchEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  branches: BoundaryBranch[];
  pinning: {
    callers: FunctionCaller[];
    testReferences: string[];
    /** Present only when a test reaches the function through a named seam. */
    transitivePins?: TransitivePin[];
  };
  repository: {
    relatedModules: RelatedProjectModule[];
  };
};

const BOUNDARY_OPERATORS = new Set([">", ">=", "<", "<="]);
const EQUALITY_OPERATORS = new Set(["===", "!==", "==", "!="]);
const TIER_PATTERN = /tier|level|role|plan|band|bracket|threshold|limit|amount|price|discount|total|count|quantity|age|score|rating/i;
const ROUNDING_PATTERN = /^(floor|ceil|ceiling|round|trunc|roundHalfUp)$/i;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function isLiteralOperand(expression: Expression): boolean {
  return expression.type === "Literal"
    || expression.type === "TemplateLiteral"
    || (expression.type === "UnaryExpression" && expression.argument.type === "Literal");
}

function operandNames(expression: Expression): string[] {
  if (expression.type === "Identifier") return [expression.name];
  if (expression.type === "MemberExpression") {
    const property = expression.property.type === "Identifier" ? [expression.property.name] : [];
    if (expression.object.type === "Identifier") return [expression.object.name, ...property];
    if (expression.object.type === "MemberExpression") {
      return [...operandNames(expression.object), ...property];
    }
    return property;
  }
  if (expression.type === "ChainExpression") return operandNames(expression.expression);
  return [];
}

function asExpression(side: Expression | PrivateIdentifier): Expression | undefined {
  return side.type === "PrivateIdentifier" ? undefined : side;
}

function comparisonKind(expression: Expression): BoundaryBranchKind | undefined {
  if (expression.type !== "BinaryExpression") return undefined;
  const left = asExpression(expression.left);
  const right = asExpression(expression.right);
  if (BOUNDARY_OPERATORS.has(expression.operator)) {
    if ((left && isLiteralOperand(left)) || (right && isLiteralOperand(right))) return "comparison";
    const names = [...(left ? operandNames(left) : []), ...(right ? operandNames(right) : [])];
    if (names.some((name) => TIER_PATTERN.test(name))) return "comparison";
    return undefined;
  }
  if (EQUALITY_OPERATORS.has(expression.operator)) {
    const text = `${left ? operandNames(left).join(" ") : ""} ${right ? operandNames(right).join(" ") : ""}`;
    if (TIER_PATTERN.test(text)) return "equality-tier";
    return undefined;
  }
  return undefined;
}

function roundingName(expression: Expression): string | undefined {
  if (expression.type !== "CallExpression") return undefined;
  const callee = expression.callee;
  if (
    callee.type === "MemberExpression"
    && callee.object.type === "Identifier"
    && callee.object.name === "Math"
    && callee.property.type === "Identifier"
    && ROUNDING_PATTERN.test(callee.property.name)
  ) return callee.property.name;
  if (callee.type === "Identifier" && ROUNDING_PATTERN.test(callee.name)) return callee.name;
  return undefined;
}

function boundaryKindOf(test: Expression): { kind: BoundaryBranchKind; predicate: Expression } | undefined {
  if (test.type === "LogicalExpression") {
    const left = boundaryKindOf(test.left);
    if (left) return left;
    return boundaryKindOf(test.right);
  }
  const comparison = comparisonKind(test);
  if (comparison) return { kind: comparison, predicate: test };
  if (test.type === "CallExpression" && roundingName(test)) {
    return { kind: "rounding", predicate: test };
  }
  return undefined;
}

function testReferences(name: string, projectFiles: ProjectFile[]): string[] {
  return projectFiles
    .filter((file) => /test|spec|__tests__|\.test\.|\.spec\./i.test(file.filePath))
    .filter((file) => file.source.includes(name))
    .map((file) => file.filePath)
    .slice(0, 10);
}

export function buildUnpinnedBoundaryBranchEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnpinnedBoundaryBranchEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const branches: BoundaryBranch[] = [];
  const visitTest = (test: Expression): void => {
    const found = boundaryKindOf(test);
    if (!found) return;
    branches.push({
      source: nodeSource(test, ownerFile.source).slice(0, 300),
      line: lineAt(ownerFile.source, test.start),
      kind: found.kind,
      predicate: nodeSource(found.predicate, ownerFile.source).slice(0, 300),
    });
  };
  new Visitor({
    IfStatement(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      visitTest(node.test);
    },
    ConditionalExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      visitTest(node.test);
    },
  }).visit(parsed.program);
  if (branches.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  const pinning: UnpinnedBoundaryBranchEvidence["pinning"] = {
    callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
    testReferences: name ? testReferences(name, projectFiles) : [],
  };
  if (name) {
    const transitivePins = findTransitiveTestPins(candidate.filePath, name, projectFiles);
    if (transitivePins.length > 0) pinning.transitivePins = transitivePins;
  }
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    branches: branches.slice(0, 10),
    pinning,
    repository: {
      relatedModules: findRelatedProjectModules(
        candidate.filePath,
        parsed.program,
        projectFiles,
      ),
    },
  };
}
