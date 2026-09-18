import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { BindingPattern, Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type PathTraversalJoinEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  joins: TraversalJoin[];
  callers: FunctionCaller[];
};

type TraversalJoin = {
  expression: string;
  kind: "path-join" | "fs-call";
  segment: string;
  paramDerived: boolean;
  hasConfinementGuard: boolean;
  importedFrom: string | null;
};

const PATH_METHODS = new Set(["join", "resolve"]);

const FS_METHODS = new Set([
  "appendFile",
  "appendFileSync",
  "copyFile",
  "copyFileSync",
  "createReadStream",
  "createWriteStream",
  "open",
  "openSync",
  "readFile",
  "readFileSync",
  "readdir",
  "readdirSync",
  "stat",
  "statSync",
  "unlink",
  "unlinkSync",
  "writeFile",
  "writeFileSync",
]);

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootIdentifier(expression.object);
  }
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  if (expression.type === "ParenthesizedExpression") return rootIdentifier(expression.expression);
  if (
    expression.type === "TSAsExpression"
    || expression.type === "TSNonNullExpression"
    || expression.type === "TSSatisfiesExpression"
    || expression.type === "TSTypeAssertion"
  ) return rootIdentifier(expression.expression);
  return undefined;
}

function calleeParts(expression: Expression): { root: string; method: string } | undefined {
  const unwrapped = expression.type === "ChainExpression" ? expression.expression : expression;
  if (unwrapped.type !== "MemberExpression" || unwrapped.computed) return undefined;
  const method = unwrapped.property.type === "Identifier" ? unwrapped.property.name : undefined;
  const root = rootIdentifier(unwrapped.object);
  if (!root || !method) return undefined;
  return { root, method };
}

function parameterNames(fn: FunctionNode): Set<string> {
  const result = new Set<string>();
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    if (value.type === "Identifier") result.add(value.name);
    else if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
      result.add(value.left.name);
    } else if (value.type === "RestElement" && value.argument.type === "Identifier") {
      result.add(value.argument.name);
    }
  }
  return result;
}

function isConstant(expression: Expression): boolean {
  return expression.type === "Literal"
    || expression.type === "TemplateLiteral" && expression.expressions.length === 0;
}

function declaredNames(id: BindingPattern): string[] {
  if (id.type === "Identifier") return [id.name];
  if (id.type === "ObjectPattern") {
    return id.properties.flatMap((property) => {
      if (property.type === "RestElement") {
        return property.argument.type === "Identifier" ? [property.argument.name] : [];
      }
      const value = property.value;
      if (value.type === "Identifier") return [value.name];
      if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
        return [value.left.name];
      }
      return [];
    });
  }
  return [];
}

export function buildPathTraversalJoinEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): PathTraversalJoinEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const imports = moduleImports(parsed.program);
  const parameters = parameterNames(fn);
  const joins: Array<TraversalJoin & { start: number; roots: string[] }> = [];
  const guardedRoots = new Set<string>();
  const aliases = new Map<string, Set<string>>();

  const resolveRoots = (name: string): Set<string> => {
    if (parameters.has(name)) return new Set([name]);
    return aliases.get(name) ?? new Set();
  };

  const deepRoots = (expression: Expression, into: Set<string>): void => {
    if (expression.type === "Identifier") {
      for (const root of resolveRoots(expression.name)) into.add(root);
      return;
    }
    if (expression.type === "MemberExpression") {
      const root = rootIdentifier(expression);
      if (root) for (const resolved of resolveRoots(root)) into.add(resolved);
      return;
    }
    if (expression.type === "TemplateLiteral") {
      for (const part of expression.expressions) deepRoots(part, into);
      return;
    }
    if (
      expression.type === "BinaryExpression"
      || expression.type === "LogicalExpression"
    ) {
      if (expression.left.type !== "PrivateIdentifier") deepRoots(expression.left, into);
      deepRoots(expression.right, into);
      return;
    }
    if (expression.type === "CallExpression" || expression.type === "NewExpression") {
      for (const argument of expression.arguments) {
        if (argument.type !== "SpreadElement") deepRoots(argument, into);
      }
      deepRoots(expression.callee, into);
      return;
    }
    if (expression.type === "UnaryExpression" || expression.type === "AwaitExpression") {
      deepRoots(expression.argument, into);
      return;
    }
    if (expression.type === "ConditionalExpression") {
      deepRoots(expression.consequent, into);
      deepRoots(expression.alternate, into);
      return;
    }
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
    CallExpression(node) {
      if (functionDepth !== 1) return;
      const parts = calleeParts(node.callee);
      if (!parts) return;
      const args = node.arguments.filter((argument): argument is Expression =>
        argument.type !== "SpreadElement");
      if (parts.method === "normalize" || parts.method === "basename") {
        for (const argument of args) {
          const roots = new Set<string>();
          deepRoots(argument, roots);
          for (const root of roots) guardedRoots.add(root);
        }
        return;
      }
      if (parts.method === "startsWith" || parts.method === "includes") {
        const receiver = node.callee.type === "MemberExpression"
          ? rootIdentifier(node.callee.object)
          : undefined;
        const receiverRoots = receiver ? resolveRoots(receiver) : new Set<string>();
        if (receiverRoots.size > 0) {
          for (const root of receiverRoots) guardedRoots.add(root);
        }
        return;
      }
      const isPathJoin = (parts.root === "path" || parts.root.endsWith("path"))
        && PATH_METHODS.has(parts.method);
      const isFsCall = FS_METHODS.has(parts.method);
      if (!isPathJoin && !isFsCall) return;
      for (const argument of args) {
        if (isConstant(argument)) continue;
        const roots = new Set<string>();
        deepRoots(argument, roots);
        // Constant and module-local segments abstain: only caller-supplied
        // segments can escape the intended directory.
        if (roots.size === 0) continue;
        const imported = imports.find(({ local }) => local === parts.root);
        joins.push({
          expression: owner.source.slice(node.start, node.end).slice(0, 200),
          kind: isPathJoin ? "path-join" : "fs-call",
          segment: owner.source.slice(argument.start, argument.end).slice(0, 120),
          paramDerived: true,
          hasConfinementGuard: false,
          importedFrom: imported?.source ?? null,
          start: node.start,
          roots: [...roots],
        });
      }
    },
    VariableDeclarator(node) {
      if (functionDepth !== 1 || !node.init) return;
      const names = declaredNames(node.id);
      if (names.length === 0) return;
      const roots = new Set<string>();
      deepRoots(node.init, roots);
      if (roots.size === 0) return;
      for (const name of names) aliases.set(name, roots);
    },
    IfStatement(node) {
      if (functionDepth !== 1) return;
      const text = owner.source.slice(node.test.start, node.test.end);
      if (!text.includes("..") && !text.toLowerCase().includes("startswith")) return;
      const roots = new Set<string>();
      deepRoots(node.test, roots);
      for (const root of roots) guardedRoots.add(root);
    },
  }).visit(parsed.program);

  if (joins.length === 0) return undefined;

  for (const join of joins) {
    join.hasConfinementGuard = join.roots.some((root) => guardedRoots.has(root));
  }

  joins.sort((left, right) => left.start - right.start);
  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    joins: joins
      .slice(0, 20)
      .map(({ expression, kind, segment, paramDerived, hasConfinementGuard, importedFrom }) => ({
        expression,
        kind,
        segment,
        paramDerived,
        hasConfinementGuard,
        importedFrom,
      })),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
