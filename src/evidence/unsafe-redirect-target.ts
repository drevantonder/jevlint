import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { AssignmentTarget, Expression } from "oxc-parser";
import type { CallExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type UnsafeRedirectTargetEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  redirects: UnsafeRedirect[];
  callers: FunctionCaller[];
};

type UnsafeRedirect = {
  expression: string;
  kind: "redirect-call" | "location-assign" | "router-push";
  target: string;
  callerControlled: boolean;
  hasAllowCheck: boolean;
};

const ROUTER_METHODS = new Set(["push", "replace", "navigate"]);

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

function memberPath(expression: AssignmentTarget | Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (
    expression.type === "TSAsExpression"
    || expression.type === "TSNonNullExpression"
    || expression.type === "TSSatisfiesExpression"
    || expression.type === "TSTypeAssertion"
    || expression.type === "ChainExpression"
    || expression.type === "ParenthesizedExpression"
  ) return memberPath(expression.expression);
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

function isConstant(expression: Expression): boolean {
  return expression.type === "Literal"
    || expression.type === "TemplateLiteral" && expression.expressions.length === 0;
}

export function buildUnsafeRedirectTargetEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnsafeRedirectTargetEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const parameters = parameterNames(fn);
  const redirects: Array<UnsafeRedirect & { start: number; end: number; targetRoot: string | undefined }> = [];
  const allowCheckedRoots = new Set<string>();
  let hasUrlConstruction = false;
  let hasSwitchOnTarget = false;

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

  const targetOf = (call: Pick<CallExpression, "callee" | "arguments">): Expression | undefined => {
    const callee = call.callee.type === "ChainExpression" ? call.callee.expression : call.callee;
    if (callee.type !== "MemberExpression" || callee.computed) {
      if (callee.type === "Identifier" && (callee.name === "redirect" || callee.name === "navigate")) {
        return call.arguments[0]?.type === "SpreadElement" ? undefined : call.arguments[0];
      }
      return undefined;
    }
    const property = callee.property.type === "Identifier" ? callee.property.name : undefined;
    if (!property) return undefined;
    if (property === "redirect") {
      const args = call.arguments.filter((argument) => argument.type !== "SpreadElement");
      const last = args[args.length - 1];
      return last;
    }
    if (
      (property === "assign" || property === "replace")
      && memberPath(callee.object) === "location"
      || ROUTER_METHODS.has(property)
    ) {
      const first = call.arguments[0];
      return first?.type === "SpreadElement" ? undefined : first;
    }
    return undefined;
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
      const target = targetOf(node);
      if (!target || isConstant(target)) return;
      const root = rootIdentifier(target);
      const callee = node.callee.type === "ChainExpression" ? node.callee.expression : node.callee;
      const property = callee.type === "MemberExpression"
          && callee.property.type === "Identifier"
        ? callee.property.name
        : callee.type === "Identifier"
          ? callee.name
          : "";
      const kind = property === "redirect" || property === "navigate"
        ? "redirect-call"
        : (memberPath(callee) ?? "").startsWith("location")
          ? "location-assign"
          : "router-push";
      redirects.push({
        expression: owner.source.slice(node.start, node.end).slice(0, 200),
        kind,
        target: owner.source.slice(target.start, target.end).slice(0, 120),
        callerControlled: root !== undefined && parameters.has(root),
        hasAllowCheck: false,
        start: node.start,
        end: node.end,
        targetRoot: root,
      });
      if (
        node.arguments.some((argument) => argument.type === "NewExpression")
        || target.type === "NewExpression"
      ) hasUrlConstruction = true;
    },
    NewExpression(node) {
      if (functionDepth !== 1) return;
      if (node.callee.type === "Identifier" && node.callee.name === "URL") {
        hasUrlConstruction = true;
      }
    },
    AssignmentExpression(node) {
      if (functionDepth !== 1) return;
      const path = memberPath(node.left);
      if (path !== "location.href") return;
      if (isConstant(node.right)) return;
      const root = rootIdentifier(node.right);
      redirects.push({
        expression: owner.source.slice(node.start, node.end).slice(0, 200),
        kind: "location-assign",
        target: owner.source.slice(node.right.start, node.right.end).slice(0, 120),
        callerControlled: root !== undefined && parameters.has(root),
        hasAllowCheck: false,
        start: node.start,
        end: node.end,
        targetRoot: root,
      });
    },
    SwitchStatement(node) {
      if (functionDepth !== 1) return;
      const root = rootIdentifier(node.discriminant);
      if (root && parameters.has(root)) hasSwitchOnTarget = true;
    },
    BinaryExpression(node) {
      if (functionDepth !== 1) return;
      if (node.operator !== "===" && node.operator !== "!==") return;
      const root = rootIdentifier(node.left) ?? rootIdentifier(node.right);
      if (root && parameters.has(root)) allowCheckedRoots.add(root);
    },
  }).visit(parsed.program);

  if (redirects.length === 0) return undefined;

  // One-hop discipline: an allow-check counts when the target root is compared
  // against a literal, confined by URL construction, or dispatched over a
  // closed switch. Constant targets already abstained above.
  for (const redirect of redirects) {
    redirect.hasAllowCheck = hasUrlConstruction
      || hasSwitchOnTarget
      || (redirect.targetRoot !== undefined && allowCheckedRoots.has(redirect.targetRoot));
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    redirects: redirects
      .sort((left, right) => left.start - right.start)
      .slice(0, 20)
      .map(({ expression, kind, target, callerControlled, hasAllowCheck }) => ({
        expression,
        kind,
        target,
        callerControlled,
        hasAllowCheck,
      })),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
