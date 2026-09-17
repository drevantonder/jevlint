import { parseSync, Visitor } from "oxc-parser";
import type { Expression, PropertyKey } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type OverbroadOriginTrustEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  grants: OriginGrant[];
  hasOriginCheck: boolean;
  withCredentials: boolean;
  callers: FunctionCaller[];
};

type OriginGrant = {
  expression: string;
  kind: "allow-origin-header" | "post-message" | "cors-config" | "wildcard-allow-list";
};

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootIdentifier(expression.object);
  }
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  if (expression.type === "ParenthesizedExpression") return rootIdentifier(expression.expression);
  return undefined;
}

function memberPath(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "ChainExpression" || expression.type === "ParenthesizedExpression") {
    return memberPath(expression.expression);
  }
  if (expression.type === "MemberExpression" && !expression.computed) {
    const object = memberPath(expression.object);
    const property = expression.property.type === "Identifier" ? expression.property.name : undefined;
    if (object && property) return `${object}.${property}`;
  }
  return undefined;
}

function stringValue(expression: Expression, source: string): string | undefined {
  if (expression.type !== "Literal") return undefined;
  const raw = source.slice(expression.start, expression.end);
  if (raw.length >= 2 && (raw.startsWith("\"") || raw.startsWith("'"))) return raw.slice(1, -1);
  return undefined;
}

function isStringLiteral(expression: Expression, source: string, value?: string): boolean {
  const text = stringValue(expression, source);
  if (text === undefined) return false;
  return value === undefined || text === value;
}

function originConfigValue(expression: Expression, source: string): boolean {
  if (isStringLiteral(expression, source, "*")) return true;
  if (expression.type === "Literal") {
    return source.slice(expression.start, expression.end) === "true";
  }
  if (expression.type === "ArrayExpression") {
    return expression.elements.some((element) => element !== null
      && element.type !== "SpreadElement"
      && isStringLiteral(element, source, "*"));
  }
  return false;
}

function originPropertyName(key: PropertyKey, source: string): string | undefined {
  if (key.type === "Identifier") return key.name;
  if (key.type !== "Literal") return undefined;
  const raw = source.slice(key.start, key.end);
  if (raw.length >= 2 && (raw.startsWith("\"") || raw.startsWith("'"))) return raw.slice(1, -1);
  return undefined;
}

function normalized(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, "");
}

function isOriginKey(name: string): boolean {
  const folded = normalized(name);
  return folded === "origin"
    || folded === "origins"
    || folded === "allowedorigins"
    || folded === "allowlist"
    || folded === "allowedlist"
    || folded === "alloworigin"
    || folded === "accesscontrolalloworigin";
}

export function buildOverbroadOriginTrustEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): OverbroadOriginTrustEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const grants: Array<OriginGrant & { start: number }> = [];
  const corsConfigArgs = new Set<number>();
  let hasOriginCheck = false;

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

  const push = (node: { start: number; end: number }, kind: OriginGrant["kind"]): void => {
    grants.push({
      expression: owner.source.slice(node.start, node.end).slice(0, 200),
      kind,
      start: node.start,
    });
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
      const path = memberPath(node.callee);
      const root = rootIdentifier(node.callee);
      if (!path || !root) return;
      const args = node.arguments.filter((argument): argument is Expression =>
        argument.type !== "SpreadElement");
      const first = args[0];
      const second = args[1];
      if (
        (path.endsWith(".setHeader") || path.endsWith(".set") || path.endsWith(".header"))
        && first
        && second
        && isOriginKey(originPropertyName(first, owner.source) ?? "")
        && isStringLiteral(second, owner.source, "*")
      ) {
        push(node, "allow-origin-header");
        return;
      }
      if (path.endsWith(".postMessage") && second && isStringLiteral(second, owner.source, "*")) {
        push(node, "post-message");
        return;
      }
      if ((root === "cors" || path.endsWith(".cors")) && first?.type === "ObjectExpression") {
        for (const property of first.properties) {
          if (property.type !== "Property") continue;
          const key = originPropertyName(property.key, owner.source);
          if (key && isOriginKey(key) && originConfigValue(property.value, owner.source)) {
            corsConfigArgs.add(first.start);
            push(node, "cors-config");
            return;
          }
        }
      }
    },
    ObjectExpression(node) {
      if (functionDepth !== 1) return;
      if (corsConfigArgs.has(node.start)) return;
      for (const property of node.properties) {
        if (property.type !== "Property") continue;
        const key = originPropertyName(property.key, owner.source);
        if (!key || !isOriginKey(key)) continue;
        if (originConfigValue(property.value, owner.source)) {
          push(property, "wildcard-allow-list");
          return;
        }
      }
    },
    BinaryExpression(node) {
      if (functionDepth !== 1) return;
      if (node.operator !== "===" && node.operator !== "!==") return;
      const text = owner.source.slice(node.start, node.end).toLowerCase();
      if (text.includes("origin")) hasOriginCheck = true;
    },
  }).visit(parsed.program);

  if (grants.length === 0) return undefined;

  const lowered = candidate.source.toLowerCase();
  const withCredentials = lowered.includes("allow-credentials")
    || lowered.includes("allowcredentials")
    || lowered.includes("withcredentials")
    || lowered.includes("credentials: true")
    || lowered.includes("credentials:true");

  grants.sort((left, right) => left.start - right.start);
  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    grants: grants
      .slice(0, 20)
      .map(({ expression, kind }) => ({ expression, kind })),
    hasOriginCheck,
    withCredentials,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
