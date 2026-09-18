import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type FloatingMoneyArithmeticEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  operations: string[];
  moneyNames: string[];
  usesToFixedComparison: boolean;
  decimalLibrary: string | null;
  hasMinorUnitHandling: boolean;
  siblingIntegerCents: boolean;
  callers: FunctionCaller[];
};

const MONEY_TOKEN = /amount|price|total|balance|cents|subtotal|cost|fee|tax|discount|payment|invoice|salary|wage|revenue|refund/i;

const DECIMAL_SOURCES = ["decimal", "big.js", "bignumber", "dinero", "currency", "money"];

function rootName(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootName(expression.object);
  }
  if (expression.type === "ChainExpression") return rootName(expression.expression);
  if (expression.type === "ParenthesizedExpression") return rootName(expression.expression);
  if (
    expression.type === "TSAsExpression"
    || expression.type === "TSNonNullExpression"
    || expression.type === "TSSatisfiesExpression"
    || expression.type === "TSTypeAssertion"
  ) return rootName(expression.expression);
  return undefined;
}

function expressionNames(expression: Expression, result: Set<string>): void {
  if (expression.type === "Identifier") {
    if (MONEY_TOKEN.test(expression.name)) result.add(expression.name);
    return;
  }
  if (expression.type === "MemberExpression") {
    if (!expression.computed && expression.property.type === "Identifier" && MONEY_TOKEN.test(expression.property.name)) {
      result.add(expression.property.name);
    }
    expressionNames(expression.object, result);
    return;
  }
  if (expression.type === "CallExpression" || expression.type === "NewExpression") {
    const root = expression.callee.type === "Identifier"
      ? expression.callee.name
      : rootName(expression.callee);
    if (root && MONEY_TOKEN.test(root)) result.add(root);
  }
}

export function buildFloatingMoneyArithmeticEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): FloatingMoneyArithmeticEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const operations: string[] = [];
  const moneyNames = new Set<string>();
  let usesToFixedComparison = false;

  const push = (node: { start: number; end: number }): void => {
    if (operations.length < 20) operations.push(owner.source.slice(node.start, node.end).slice(0, 240));
  };

  let functionDepth = 0;
  const isDirect = (node: FunctionNode): boolean => node.start === fn.start && node.end === fn.end;
  const enterFunction = (node: FunctionNode): void => {
    if (isDirect(node)) functionDepth = 1;
    else if (functionDepth > 0) functionDepth += 1;
  };
  const exitFunction = (node: FunctionNode): void => {
    if (functionDepth === 0) return;
    functionDepth -= 1;
    if (isDirect(node)) functionDepth = 0;
  };

  new Visitor({
    ArrowFunctionExpression: enterFunction,
    "ArrowFunctionExpression:exit": exitFunction,
    FunctionDeclaration: enterFunction,
    "FunctionDeclaration:exit": exitFunction,
    FunctionExpression: enterFunction,
    "FunctionExpression:exit": exitFunction,
    BinaryExpression(node) {
      if (functionDepth !== 1) return;
      if (node.operator !== "+" && node.operator !== "-" && node.operator !== "*" && node.operator !== "/" && node.operator !== "%") {
        return;
      }
      const found = new Set<string>();
      expressionNames(node.left, found);
      expressionNames(node.right, found);
      if (found.size === 0) return;
      for (const item of found) moneyNames.add(item);
      push(node);
    },
    AssignmentExpression(node) {
      if (functionDepth !== 1) return;
      if (node.operator !== "+=" && node.operator !== "-=" && node.operator !== "*=" && node.operator !== "/=" && node.operator !== "%=") {
        return;
      }
      const found = new Set<string>();
      if (node.left.type === "Identifier" || node.left.type === "MemberExpression") {
        expressionNames(node.left, found);
      }
      expressionNames(node.right, found);
      if (found.size === 0) return;
      for (const item of found) moneyNames.add(item);
      push(node);
    },
    CallExpression(node) {
      if (functionDepth !== 1) return;
      const callee = node.callee.type === "ChainExpression" ? node.callee.expression : node.callee;
      if (
        callee.type === "MemberExpression"
        && !callee.computed
        && callee.property.type === "Identifier"
        && callee.property.name === "toFixed"
      ) {
        const root = rootName(callee.object);
        if (root && MONEY_TOKEN.test(root)) {
          moneyNames.add(root);
          usesToFixedComparison = true;
          push(node);
        }
      }
    },
  }).visit(parsed.program);

  if (operations.length === 0) return undefined;

  const body = owner.source.slice(fn.start, fn.end);
  const imports = moduleImports(parsed.program);
  const decimalImport = imports.find(({ source }) =>
    DECIMAL_SOURCES.some((token) => source.toLowerCase().includes(token))
  );
  const hasMinorUnitHandling = /\*\s*100|\/\s*100|Math\.round|minorUnit|_cents\b|\bcents\b/.test(body);

  let siblingIntegerCents = false;
  for (const file of projectFiles) {
    if (file.filePath === owner.filePath) continue;
    if (/\bcents\b|minorUnit|minor_unit|amountCents/.test(file.source)) {
      siblingIntegerCents = true;
      break;
    }
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    operations,
    moneyNames: [...moneyNames].slice(0, 10),
    usesToFixedComparison,
    decimalLibrary: decimalImport?.source ?? null,
    hasMinorUnitHandling,
    siblingIntegerCents,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
