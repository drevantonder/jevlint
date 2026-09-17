import { parseSync, Visitor } from "oxc-parser";
import type { Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
  moduleImports,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller, FunctionNode, RelatedProjectModule } from "./repository.js";

export type BoundaryRead = {
  expression: string;
  origin: "parameter" | "fetch-result" | "json-payload" | "parse-wrapper" | "parsed-result";
  property: string | null;
};

export type BoundaryValidator = {
  kind: "schema-parse" | "success-check" | "type-narrowing" | "key-check" | "instance-check";
  expression: string;
};

export type UnvalidatedBoundaryEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  boundaryReads: BoundaryRead[];
  validators: BoundaryValidator[];
  validationLibrary: { importedFrom: string; local: string } | null;
  relatedModules: RelatedProjectModule[];
  callers: FunctionCaller[];
};

const BOUNDARY_PARAMETERS = new Set([
  "req",
  "request",
  "res",
  "response",
  "event",
  "payload",
  "body",
  "input",
  "message",
  "webhook",
  "data",
  "params",
  "query",
  "headers",
  "integration",
  "incoming",
  "raw",
]);

const BOUNDARY_CALL_PATTERN = /fetch|\.json\(|JSON\.parse|safeParse/i;
const VALIDATOR_CALL_PATTERN = /\.parse\(|validate|assert|ensure|checkShape|isValid/i;

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootIdentifier(expression.object);
  }
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  if (
    expression.type === "TSAsExpression"
    || expression.type === "TSNonNullExpression"
    || expression.type === "TSSatisfiesExpression"
    || expression.type === "TSTypeAssertion"
  ) return rootIdentifier(expression.expression);
  return undefined;
}

function propertyName(expression: Expression): string | null {
  if (expression.type !== "MemberExpression" || expression.computed) return null;
  return expression.property.type === "Identifier" ? expression.property.name : null;
}

function parameterNames(fn: FunctionNode): Set<string> {
  const result = new Set<string>();
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    if (value.type === "Identifier") result.add(value.name);
    if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
      result.add(value.left.name);
    }
    if (value.type === "RestElement" && value.argument.type === "Identifier") {
      result.add(value.argument.name);
    }
    if (value.type === "ObjectPattern") {
      for (const property of value.properties) {
        if (property.type === "Property" && property.key.type === "Identifier") {
          result.add(property.key.name);
        }
      }
    }
  }
  return result;
}

export function buildUnvalidatedBoundaryEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnvalidatedBoundaryEvidence | undefined {
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
  const direct = (node: { start: number; end: number }): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !nested.some((range) => range.start <= node.start && range.end >= node.end);
  const parameters = parameterNames(fn);
  const boundaryBindings = new Map<string, BoundaryRead["origin"]>();
  for (const parameter of parameters) {
    if (BOUNDARY_PARAMETERS.has(parameter)) boundaryBindings.set(parameter, "parameter");
  }

  const reads: Array<BoundaryRead & { start: number }> = [];
  const validators: BoundaryValidator[] = [];

  new Visitor({
    VariableDeclarator(node) {
      if (!direct(node) || node.id.type !== "Identifier" || !node.init) return;
      const text = owner.source.slice(node.init.start, node.init.end);
      if (!BOUNDARY_CALL_PATTERN.test(text)) return;
      const origin: BoundaryRead["origin"] = /safeParse/i.test(text)
        ? "parse-wrapper"
        : /\.json\(|fetch/i.test(text)
          ? "json-payload"
          : /JSON\.parse/i.test(text)
            ? "fetch-result"
            : "parsed-result";
      boundaryBindings.set(node.id.name, origin);
    },
  }).visit(parsed.program);

  new Visitor({
    VariableDeclarator(node) {
      if (!direct(node) || node.id.type !== "ObjectPattern" || !node.init) return;
      if (node.init.type !== "Identifier") return;
      const origin = boundaryBindings.get(node.init.name);
      if (!origin) return;
      const keys: string[] = [];
      for (const property of node.id.properties) {
        if (property.type === "Property" && property.key.type === "Identifier") {
          keys.push(property.key.name);
        }
      }
      reads.push({
        expression: owner.source.slice(node.start, node.end),
        origin,
        property: keys.length > 0 ? keys.join(", ") : null,
        start: node.start,
      });
    },
    MemberExpression(node) {
      if (!direct(node)) return;
      const root = rootIdentifier(node);
      if (!root) return;
      const origin = boundaryBindings.get(root);
      if (!origin) return;
      reads.push({
        expression: owner.source.slice(node.start, node.end),
        origin,
        property: propertyName(node),
        start: node.start,
      });
    },
    CallExpression(node) {
      if (!direct(node)) return;
      const text = owner.source.slice(node.start, node.end);
      if (!VALIDATOR_CALL_PATTERN.test(text)) return;
      const callee = owner.source.slice(node.callee.start, node.callee.end);
      validators.push({
        kind: /\.parse\(/.test(text) ? "schema-parse" : "key-check",
        expression: `${callee}(…)`,
      });
    },
    BinaryExpression(node) {
      if (!direct(node)) return;
      if (node.operator === "instanceof") {
        validators.push({
          kind: "instance-check",
          expression: owner.source.slice(node.start, node.end),
        });
        return;
      }
      if (node.operator === "in") {
        validators.push({
          kind: "key-check",
          expression: owner.source.slice(node.start, node.end),
        });
        return;
      }
      if (
        (node.operator === "===" || node.operator === "!==")
        && (node.left.type === "UnaryExpression" || node.right.type === "UnaryExpression")
      ) {
        const text = owner.source.slice(node.start, node.end);
        if (/\btypeof\b/.test(text)) {
          validators.push({ kind: "type-narrowing", expression: text });
        }
      }
    },
  }).visit(parsed.program);

  const successReads: BoundaryValidator[] = [];
  new Visitor({
    MemberExpression(node) {
      if (!direct(node)) return;
      if (node.computed || node.property.type !== "Identifier" || node.property.name !== "success") {
        return;
      }
      successReads.push({
        kind: "success-check",
        expression: owner.source.slice(node.start, node.end),
      });
    },
  }).visit(parsed.program);
  validators.push(...successReads);

  if (reads.length === 0) return undefined;

  const imports = moduleImports(parsed.program);
  const validationImport = imports.find(({ source, local }) =>
    /zod|yup|joi|ajv|valibot|io-ts|superstruct|validator/i.test(source)
    || /schema|validator|Schema|Validator/i.test(local)
  );

  reads.sort((left, right) => left.start - right.start);
  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    boundaryReads: reads.map(({ expression, origin, property }) => ({
      expression,
      origin,
      property,
    })),
    validators,
    validationLibrary: validationImport
      ? { importedFrom: validationImport.source, local: validationImport.local }
      : null,
    relatedModules: findRelatedProjectModules(owner.filePath, parsed.program, projectFiles),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
