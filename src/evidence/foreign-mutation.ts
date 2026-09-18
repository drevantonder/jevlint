import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { AssignmentTarget, Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

type ForeignOwnership = "imported-binding" | "global" | "prototype";

type ForeignMutation = {
  operation: string;
  target: string;
  ownership: ForeignOwnership;
};

type ImportedTarget = {
  local: string;
  source: string;
};

export type ForeignMutationEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  mutations: ForeignMutation[];
  importedTargets: ImportedTarget[];
  callers: FunctionCaller[];
};

const GLOBAL_ROOTS = new Set(["globalThis", "global", "self", "window", "process"]);

const MUTATING_METHODS = new Set([
  "add",
  "clear",
  "copyWithin",
  "delete",
  "fill",
  "pop",
  "push",
  "reverse",
  "set",
  "shift",
  "sort",
  "splice",
  "unshift",
]);

function rootIdentifier(expression: AssignmentTarget | Expression): string | undefined {
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

function memberPath(expression: AssignmentTarget | Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (
    expression.type === "TSAsExpression"
    || expression.type === "TSNonNullExpression"
    || expression.type === "TSSatisfiesExpression"
    || expression.type === "TSTypeAssertion"
    || expression.type === "ChainExpression"
    || expression.type === "ParenthesizedExpression"
  ) {
    return memberPath(expression.expression);
  }
  if (expression.type === "MemberExpression" && !expression.computed) {
    const object = memberPath(expression.object);
    const property = expression.property.type === "Identifier" ? expression.property.name : undefined;
    if (object && property) return `${object}.${property}`;
  }
  return undefined;
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

function classifyWrite(
  target: string,
  root: string | undefined,
  parameters: Set<string>,
  importedLocals: Set<string>,
): ForeignOwnership | undefined {
  if (root === undefined) return undefined;
  if (target.includes(".prototype.") || target.endsWith(".prototype")) return "prototype";
  if (parameters.has(root)) return undefined;
  if (GLOBAL_ROOTS.has(root)) return "global";
  if (importedLocals.has(root)) return "imported-binding";
  return undefined;
}

export function buildForeignMutationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ForeignMutationEvidence | undefined {
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
  const importedLocals = new Set(imports.map(({ local }) => local));
  const parameters = parameterNames(fn);
  const mutations: ForeignMutation[] = [];

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
    AssignmentExpression(node) {
      if (functionDepth !== 1) return;
      const target = memberPath(node.left);
      if (!target) return;
      const ownership = classifyWrite(target, rootIdentifier(node.left), parameters, importedLocals);
      if (ownership) {
        mutations.push({
          operation: owner.source.slice(node.start, node.end).slice(0, 160),
          target,
          ownership,
        });
      }
    },
    UpdateExpression(node) {
      if (functionDepth !== 1 || node.argument.type !== "MemberExpression") return;
      const target = memberPath(node.argument);
      if (!target) return;
      const ownership = classifyWrite(target, rootIdentifier(node.argument), parameters, importedLocals);
      if (ownership) {
        mutations.push({
          operation: owner.source.slice(node.start, node.end).slice(0, 160),
          target,
          ownership,
        });
      }
    },
    UnaryExpression(node) {
      if (functionDepth !== 1 || node.operator !== "delete" || node.argument.type !== "MemberExpression") return;
      const target = memberPath(node.argument);
      if (!target) return;
      const ownership = classifyWrite(target, rootIdentifier(node.argument), parameters, importedLocals);
      if (ownership) {
        mutations.push({
          operation: owner.source.slice(node.start, node.end).slice(0, 160),
          target,
          ownership,
        });
      }
    },
    CallExpression(node) {
      if (functionDepth !== 1) return;
      if (
        node.callee.type === "MemberExpression"
        && !node.callee.computed
        && node.callee.object.type === "Identifier"
        && node.callee.object.name === "Object"
        && node.callee.property.type === "Identifier"
        && ["assign", "defineProperties", "defineProperty", "setPrototypeOf"].includes(node.callee.property.name)
      ) {
        const [target] = node.arguments;
        const root = target && target.type !== "SpreadElement" ? rootIdentifier(target) : undefined;
        const ownership = root === undefined || parameters.has(root)
          ? undefined
          : GLOBAL_ROOTS.has(root)
            ? "global"
            : importedLocals.has(root)
              ? "imported-binding"
              : undefined;
        if (ownership && target) {
          mutations.push({
            operation: owner.source.slice(node.start, node.end).slice(0, 160),
            target: owner.source.slice(target.start, target.end).slice(0, 120),
            ownership,
          });
        }
        return;
      }
      if (
        node.callee.type === "MemberExpression"
        && !node.callee.computed
        && node.callee.property.type === "Identifier"
        && MUTATING_METHODS.has(node.callee.property.name)
      ) {
        const root = rootIdentifier(node.callee.object);
        const target = memberPath(node.callee.object);
        if (!target) return;
        const ownership = classifyWrite(target, root, parameters, importedLocals);
        if (ownership) {
          mutations.push({
            operation: owner.source.slice(node.start, node.end).slice(0, 160),
            target,
            ownership,
          });
        }
      }
    },
  }).visit(parsed.program);

  if (mutations.length === 0) return undefined;

  const touchedRoots = new Set(mutations.map(({ target }) => target.split(".")[0]));
  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    mutations: mutations.slice(0, 20),
    importedTargets: imports
      .filter(({ local }) => touchedRoots.has(local))
      .map(({ local, source }) => ({ local, source })),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
