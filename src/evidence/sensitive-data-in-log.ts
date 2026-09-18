import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Argument, Expression, Program, PropertyKey } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type SensitiveDataInLogEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  logs: SensitiveLog[];
  callers: FunctionCaller[];
};

type SensitiveLog = {
  sink: string;
  expression: string;
  sensitiveFields: string[];
  spreadsWholeRecord: boolean;
  hasRedaction: boolean;
  loggerImportedFrom: string | null;
};

const LOG_ROOTS = new Set([
  "analytics",
  "console",
  "log",
  "logger",
  "metrics",
  "telemetry",
]);

const LOG_METHODS = new Set([
  "debug",
  "error",
  "event",
  "info",
  "log",
  "metric",
  "trace",
  "track",
  "verbose",
  "warn",
]);

const SENSITIVE_TOKENS = [
  "password",
  "passwd",
  "secret",
  "apikey",
  "api_key",
  "token",
  "auth",
  "credential",
  "privatekey",
  "private_key",
  "sessionid",
  "session_id",
  "cookie",
  "ssn",
  "socialsecurity",
  "cardnumber",
  "card_number",
  "creditcard",
  "cvv",
  "cvc",
  "bankaccount",
  "health",
  "diagnosis",
  "salary",
  "dob",
  "dateofbirth",
];

const REDACT_TOKENS = ["redact", "sanitiz", "mask", "scrub", "omit", "pick"];

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

function isLogCallee(callee: Expression): { root: string; method: string } | undefined {
  const unwrapped = callee.type === "ChainExpression" ? callee.expression : callee;
  if (unwrapped.type === "Identifier" && LOG_ROOTS.has(unwrapped.name)) {
    return { root: unwrapped.name, method: unwrapped.name };
  }
  if (unwrapped.type !== "MemberExpression" || unwrapped.computed) return undefined;
  const root = rootIdentifier(unwrapped.object);
  const method = unwrapped.property.type === "Identifier" ? unwrapped.property.name : undefined;
  if (!root || !method || !LOG_ROOTS.has(root) || !LOG_METHODS.has(method)) return undefined;
  return { root, method };
}

function normalized(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, "");
}

function isSensitiveName(name: string): boolean {
  const folded = normalized(name);
  return SENSITIVE_TOKENS.some((token) => folded.includes(token));
}

function isRedactName(name: string): boolean {
  const folded = normalized(name);
  return REDACT_TOKENS.some((token) => folded.includes(token));
}

function collectSensitive(
  expression: Argument,
  parameters: Set<string>,
  source: string,
  paramTypes: Map<string, string>,
  typeFields: Map<string, string[]>,
  fields: Set<string>,
  state: { wholeRecord: boolean; redaction: boolean },
): void {
  if (expression.type === "SpreadElement") {
    const root = rootIdentifier(expression.argument);
    if (root && (parameters.has(root) || root === "req" || root === "request" || root === "user")) {
      state.wholeRecord = true;
    }
    collectSensitive(expression.argument, parameters, source, paramTypes, typeFields, fields, state);
    return;
  }
  if (expression.type === "Identifier") {
    if (isSensitiveName(expression.name)) fields.add(expression.name);
    if (isRedactName(expression.name)) state.redaction = true;
    const typeName = paramTypes.get(expression.name);
    if (typeName) {
      for (const field of typeFields.get(typeName) ?? []) {
        if (isSensitiveName(field)) fields.add(field);
      }
    }
    return;
  }
  if (expression.type === "MemberExpression") {
    const property = !expression.computed && expression.property.type === "Identifier"
      ? expression.property.name
      : undefined;
    if (property && isSensitiveName(property)) fields.add(property);
    const root = rootIdentifier(expression);
    if (root && isRedactName(root)) state.redaction = true;
    return;
  }
  if (expression.type === "ObjectExpression") {
    for (const property of expression.properties) {
      if (property.type === "SpreadElement") {
        collectSensitive(property, parameters, source, paramTypes, typeFields, fields, state);
      } else if (property.type === "Property") {
        const key = propertyKeyName(property.key, source);
        if (key && isSensitiveName(key)) fields.add(key);
        collectSensitive(property.value, parameters, source, paramTypes, typeFields, fields, state);
      }
    }
    return;
  }
  if (expression.type === "TemplateLiteral") {
    for (const part of expression.expressions) collectSensitive(part, parameters, source, paramTypes, typeFields, fields, state);
    return;
  }
  if (expression.type === "BinaryExpression" || expression.type === "LogicalExpression") {
    if (expression.left.type !== "PrivateIdentifier") {
      collectSensitive(expression.left, parameters, source, paramTypes, typeFields, fields, state);
    }
    collectSensitive(expression.right, parameters, source, paramTypes, typeFields, fields, state);
    return;
  }
  if (expression.type === "CallExpression" || expression.type === "NewExpression") {
    const root = expression.callee.type === "Identifier"
      ? expression.callee.name
      : rootIdentifier(expression.callee);
    if (root && isRedactName(root)) state.redaction = true;
    for (const argument of expression.arguments) {
      collectSensitive(argument, parameters, source, paramTypes, typeFields, fields, state);
    }
  }
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

function parameterTypeNames(fn: FunctionNode, source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    const name = value.type === "Identifier"
      ? value.name
      : value.type === "AssignmentPattern" && value.left.type === "Identifier"
        ? value.left.name
        : undefined;
    if (!name) continue;
    const text = source.slice(parameter.start, parameter.end);
    const match = new RegExp(`^${name}\\s*:\\s*([A-Za-z_$][\\w$]*)`).exec(text.trim());
    if (match?.[1]) result.set(name, match[1]);
  }
  return result;
}

function propertyKeyName(key: PropertyKey, source: string): string | undefined {
  if (key.type === "Identifier") return key.name;
  if (key.type !== "Literal") return undefined;
  const raw = source.slice(key.start, key.end);
  if (raw.length >= 2 && (raw.startsWith("\"") || raw.startsWith("'"))) return raw.slice(1, -1);
  return undefined;
}

function moduleTypeFields(program: Program, typeName: string, source: string): string[] {
  const fields: string[] = [];
  new Visitor({
    TSInterfaceDeclaration(node) {
      if (node.id.name !== typeName) return;
      for (const member of node.body.body) {
        if (member.type !== "TSPropertySignature") continue;
        const key = propertyKeyName(member.key, source);
        if (key) fields.push(key);
      }
    },
    TSTypeAliasDeclaration(node) {
      if (node.id.name !== typeName) return;
      if (node.typeAnnotation.type !== "TSTypeLiteral") return;
      for (const member of node.typeAnnotation.members) {
        if (member.type !== "TSPropertySignature") continue;
        const key = propertyKeyName(member.key, source);
        if (key) fields.push(key);
      }
    },
  }).visit(program);
  return fields;
}

export function buildSensitiveDataInLogEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): SensitiveDataInLogEvidence | undefined {
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
  const paramTypes = parameterTypeNames(fn, owner.source);
  const typeFields = new Map<string, string[]>();
  for (const typeName of new Set(paramTypes.values())) {
    typeFields.set(typeName, moduleTypeFields(parsed.program, typeName, owner.source));
  }
  const logs: SensitiveLog[] = [];

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
      const sink = isLogCallee(node.callee);
      if (!sink) return;
      const fields = new Set<string>();
      const state = { wholeRecord: false, redaction: false };
      for (const argument of node.arguments) {
        collectSensitive(argument, parameters, owner.source, paramTypes, typeFields, fields, state);
      }
      if (fields.size === 0 && !state.wholeRecord) return;
      const imported = imports.find(({ local }) => local === sink.root);
      logs.push({
        sink: owner.source.slice(node.callee.start, node.callee.end).slice(0, 80),
        expression: owner.source.slice(node.start, node.end).slice(0, 240),
        sensitiveFields: [...fields].slice(0, 10),
        spreadsWholeRecord: state.wholeRecord,
        hasRedaction: state.redaction,
        loggerImportedFrom: imported?.source ?? null,
      });
    },
  }).visit(parsed.program);

  if (logs.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    logs: logs.slice(0, 20),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
