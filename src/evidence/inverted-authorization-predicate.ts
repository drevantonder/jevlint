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
  nestedFunctionRanges,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type AuthorizationPredicate = {
  expression: string;
  kind: "conjunction" | "permission-check" | "identity-comparison";
  operator: string | null;
};

export type SiblingPredicate = {
  expression: string;
  operator: string;
  sameFunction: boolean;
};

export type InvertedAuthorizationPredicateEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  predicates: AuthorizationPredicate[];
  siblingPredicates: SiblingPredicate[];
  permissionFramework: { importedFrom: string; local: string; source: string | null } | null;
  callers: FunctionCaller[];
};

const AUTH_PATTERN = /admin|owner|member|role|permission|scope|access|authoriz|privilege|grant|deny|superuser|can[A-Z]|is[A-Z]\w*(Allowed|Permitted|Admin|Owner)|has[A-Z]/;
const PERMISSION_CALL_PATTERN = /^(hasPermission|can[A-Z]\w*|is[A-Z]\w*|check[A-Z]\w*|authorize|hasRole|hasScope|requirePermission)$/;
const IDENTITY_PATTERN = /token|userId|ownerId|subject|principal|identity|grant|session/i;

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootIdentifier(expression.object);
  }
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  if (expression.type === "CallExpression") return rootIdentifier(expression.callee);
  return undefined;
}

function calleeName(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression" && expression.property.type === "Identifier") {
    return expression.property.name;
  }
  return undefined;
}

export function buildInvertedAuthorizationPredicateEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): InvertedAuthorizationPredicateEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const direct = (node: { start: number; end: number }): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !nested.some((range) => range.start <= node.start && range.end >= node.end);

  const predicates: AuthorizationPredicate[] = [];
  const siblings: SiblingPredicate[] = [];

  new Visitor({
    LogicalExpression(node) {
      const text = owner.source.slice(node.start, node.end);
      if (!AUTH_PATTERN.test(text)) return;
      if (direct(node)) {
        predicates.push({ expression: text, kind: "conjunction", operator: node.operator });
        return;
      }
      const sameFunction = node.start >= candidate.start && node.end <= candidate.end
        && !nested.some((range) => range.start <= node.start && range.end >= node.end);
      siblings.push({ expression: text, operator: node.operator, sameFunction });
    },
    BinaryExpression(node) {
      if (!direct(node)) return;
      if (node.operator !== "===" && node.operator !== "!==") return;
      const text = owner.source.slice(node.start, node.end);
      const left = rootIdentifier(node.left);
      const right = rootIdentifier(node.right);
      if (!left || !right) return;
      if (!IDENTITY_PATTERN.test(left) && !IDENTITY_PATTERN.test(right)) return;
      predicates.push({ expression: text, kind: "identity-comparison", operator: node.operator });
    },
    CallExpression(node) {
      if (!direct(node)) return;
      const callee = calleeName(node.callee);
      if (!callee || !PERMISSION_CALL_PATTERN.test(callee)) return;
      predicates.push({
        expression: owner.source.slice(node.start, node.end),
        kind: "permission-check",
        operator: null,
      });
    },
  }).visit(parsed.program);

  if (predicates.length === 0) return undefined;

  const imports = moduleImports(parsed.program);
  const frameworkImport = imports.find(({ source, local }) =>
    /auth|permission|policy|scope|role|access/i.test(source)
    || /auth|permission|policy|scope|role/i.test(local)
  );
  const frameworkModule = frameworkImport
    ? resolveModule(owner.filePath, frameworkImport.source, projectFiles)
    : undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    predicates,
    siblingPredicates: siblings.slice(0, 10),
    permissionFramework: frameworkImport
      ? {
        importedFrom: frameworkImport.source,
        local: frameworkImport.local,
        source: frameworkModule?.source.slice(0, 4000) ?? null,
      }
      : null,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
