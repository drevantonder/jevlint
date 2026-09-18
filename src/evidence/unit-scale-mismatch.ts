import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type UnitScaleMismatchEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  conversions: string[];
  unitNames: string[];
  hasNamedConversion: boolean;
  callers: FunctionCaller[];
};

const SCALE_FACTOR = new Set(["1000", "1024"]);

const UNIT_SUFFIX = /(Ms|Millis|Sec|Secs|Second|Seconds|Minute|Minutes|Hour|Hours|KB|MB|GB|Bytes|Micros|Nanos)$/;

const NAMED_CONVERSION = /secToMs|msToSec|toMs\b|toSeconds?|toMillis|asMillis|asSeconds|convert[A-Z].*(Ms|Sec|Bytes|KB)|fromSeconds|fromMillis/i;

function rootName(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootName(expression.object);
  }
  if (expression.type === "ChainExpression") return rootName(expression.expression);
  if (expression.type === "ParenthesizedExpression") return rootName(expression.expression);
  return undefined;
}

function collectIdentifiers(expression: Expression, result: Set<string>): void {
  if (expression.type === "Identifier") {
    result.add(expression.name);
    return;
  }
  if (expression.type === "MemberExpression") {
    if (!expression.computed && expression.property.type === "Identifier") result.add(expression.property.name);
    collectIdentifiers(expression.object, result);
  }
}

export function buildUnitScaleMismatchEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnitScaleMismatchEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const conversions: string[] = [];
  const unitNames = new Set<string>();

  const push = (node: { start: number; end: number }): void => {
    if (conversions.length < 20) conversions.push(owner.source.slice(node.start, node.end).slice(0, 240));
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
      if (node.operator !== "*" && node.operator !== "/") return;
      const literal = node.left.type === "Literal"
        ? node.left
        : node.right.type === "Literal"
          ? node.right
          : undefined;
      if (!literal) return;
      if (!SCALE_FACTOR.has(owner.source.slice(literal.start, literal.end))) return;
      const found = new Set<string>();
      collectIdentifiers(node.left, found);
      collectIdentifiers(node.right, found);
      for (const item of found) {
        if (UNIT_SUFFIX.test(item)) unitNames.add(item);
      }
      const root = rootName(node.left) ?? rootName(node.right);
      if (root) unitNames.add(root);
      push(node);
    },
    CallExpression(node) {
      if (functionDepth !== 1) return;
      for (const argument of node.arguments) {
        if (argument.type === "Identifier" && UNIT_SUFFIX.test(argument.name)) unitNames.add(argument.name);
      }
    },
  }).visit(parsed.program);

  const body = owner.source.slice(fn.start, fn.end);
  for (const match of body.matchAll(/\b[A-Za-z_$][\w$]*(?:Ms|Millis|Sec|Secs|Second|Seconds|Minute|Minutes|Hour|Hours|KB|MB|GB|Bytes)\b/g)) {
    unitNames.add(match[0]);
    if (unitNames.size >= 10) break;
  }

  if (conversions.length === 0 && unitNames.size === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    conversions,
    unitNames: [...unitNames].slice(0, 10),
    hasNamedConversion: NAMED_CONVERSION.test(body),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
